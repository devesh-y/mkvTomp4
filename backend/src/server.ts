import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8787);
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";

const SUPPORTED_SUBTITLE_CODECS = new Set(["subrip", "ass", "ssa", "mov_text"]);

type StreamInfo = {
  index: number;
  codecType: string;
  codecName?: string;
  language?: string;
  title?: string;
};

type FileScanResult = {
  inputFile: string;
  fileName: string;
  streams: StreamInfo[];
};

type ConvertJob = {
  inputFile: string;
  outputFile: string;
  audioStreamIndex: number;
  subtitleStreamIndex: number;
};

type JobStatus = "queued" | "running" | "success" | "failed" | "cancelled";

type JobResult = {
  jobId: string;
  inputFile: string;
  outputFile: string;
  status: JobStatus;
  progress: number;
  message: string;
};

type RuntimeJob = ConvertJob &
  JobResult & {
    durationSeconds: number;
    subtitleFilterIndex: number;
    cancelled: boolean;
    processPid?: number;
  };

type ConversionRun = {
  runId: string;
  concurrency: number;
  jobs: RuntimeJob[];
  isDone: boolean;
};

const scanFolderSchema = z.object({
  folderPath: z.string().min(1, "folderPath is required"),
});

const convertSchema = z.object({
  concurrency: z.number().int().min(1).max(6).optional(),
  jobs: z
    .array(
      z.object({
        inputFile: z.string().min(1),
        outputFile: z.string().min(1),
        audioStreamIndex: z.number().int().nonnegative(),
        subtitleStreamIndex: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

const cancelJobSchema = z.object({
  runId: z.string().min(1),
  jobId: z.string().min(1),
});

const activeRuns = new Map<string, ConversionRun>();

const app = express();
app.use(cors({ origin: APP_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/scan-folder", async (req, res) => {
  const parsed = scanFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const folderPath = path.resolve(parsed.data.folderPath);

  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Provided path is not a directory." });
    }

    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const mkvFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mkv"))
      .map((entry) => path.join(folderPath, entry.name))
      .sort((a, b) => a.localeCompare(b));

    if (mkvFiles.length === 0) {
      return res.status(200).json({ files: [], folderPath });
    }

    const files: FileScanResult[] = [];
    for (const filePath of mkvFiles) {
      const probe = await runFfprobe(filePath);
      const streams = (probe.streams ?? []).map((stream: any) => ({
        index: Number(stream.index),
        codecType: stream.codec_type,
        codecName: stream.codec_name,
        language: stream.tags?.language,
        title: stream.tags?.title,
      }));
      files.push({
        inputFile: filePath,
        fileName: path.basename(filePath),
        streams,
      });
    }

    return res.json({ files, folderPath });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to scan folder.",
    });
  }
});

app.post("/api/convert", async (req, res) => {
  const parsed = convertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const concurrency = parsed.data.concurrency ?? 3;
  const jobs = parsed.data.jobs;

  try {
    const preparedJobs = await Promise.all(
      jobs.map(async (job, index) => prepareJobBeforeRun(job, index)),
    );
    const runId = createRunId();
    const run: ConversionRun = {
      runId,
      concurrency,
      jobs: preparedJobs,
      isDone: false,
    };
    activeRuns.set(runId, run);
    void startRun(run);
    return res.json({
      runId,
      concurrency,
      results: serializeJobs(run.jobs),
    });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid conversion job.",
    });
  }
});

app.get("/api/convert/status/:runId", (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: "Run not found." });
  }
  return res.json({
    runId: run.runId,
    isDone: run.isDone,
    results: serializeJobs(run.jobs),
  });
});

app.post("/api/convert/cancel-job", async (req, res) => {
  const parsed = cancelJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const run = activeRuns.get(parsed.data.runId);
  if (!run) {
    return res.status(404).json({ error: "Run not found." });
  }

  const job = run.jobs.find((item) => item.jobId === parsed.data.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  if (job.status === "queued") {
    job.cancelled = true;
    job.status = "cancelled";
    job.progress = 0;
    job.message = "Cancelled by user";
    await safeDeleteFile(job.outputFile);
    return res.json({ ok: true });
  }

  if (job.status === "running" && job.processPid) {
    job.cancelled = true;
    process.kill(job.processPid, "SIGTERM");
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
});

async function prepareJobBeforeRun(job: ConvertJob, index: number): Promise<RuntimeJob> {
  const inputStat = await fs.stat(job.inputFile);
  if (!inputStat.isFile()) {
    throw new Error(`Input is not a file: ${job.inputFile}`);
  }

  const probe = await runFfprobe(job.inputFile);
  const streams = probe.streams ?? [];
  const audio = streams.find(
    (stream: any) => stream.index === job.audioStreamIndex && stream.codec_type === "audio",
  );
  const subtitle = streams.find(
    (stream: any) => stream.index === job.subtitleStreamIndex && stream.codec_type === "subtitle",
  );

  if (!audio) {
    throw new Error(`Audio stream ${job.audioStreamIndex} not found in ${job.inputFile}`);
  }
  if (!subtitle) {
    throw new Error(`Subtitle stream ${job.subtitleStreamIndex} not found in ${job.inputFile}`);
  }

  const subtitleCodec = subtitle.codec_name;
  if (!SUPPORTED_SUBTITLE_CODECS.has(subtitleCodec)) {
    throw new Error(
      `Subtitle codec "${subtitleCodec}" in ${job.inputFile} is not supported for burn-in.`,
    );
  }

  const subtitleFilterIndex = streams
    .filter((stream: any) => stream.codec_type === "subtitle")
    .findIndex((stream: any) => Number(stream.index) === job.subtitleStreamIndex);
  if (subtitleFilterIndex === -1) {
    throw new Error(`Subtitle stream ${job.subtitleStreamIndex} not found in ${job.inputFile}`);
  }

  const durationSeconds = Number(probe.format?.duration ?? 0);
  return {
    ...job,
    jobId: `job-${index}-${Date.now()}`,
    status: "queued",
    progress: 0,
    message: "Queued",
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    subtitleFilterIndex,
    cancelled: false,
  };
}

async function runConvertJob(job: RuntimeJob): Promise<void> {
  if (job.cancelled || job.status === "cancelled") {
    job.status = "cancelled";
    job.progress = 0;
    job.message = "Cancelled by user";
    await safeDeleteFile(job.outputFile);
    return;
  }

  const outputDir = path.dirname(job.outputFile);
  await fs.mkdir(outputDir, { recursive: true });

  const args = [
    "-y",
    "-i",
    job.inputFile,
    "-map",
    "0:v:0",
    "-map",
    `0:${job.audioStreamIndex}`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-vf",
    `subtitles=${escapeSubtitlesPath(job.inputFile)}:si=${job.subtitleFilterIndex}`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-sn",
    job.outputFile,
  ];

  try {
    job.status = "running";
    job.message = "Running";
    await runCommandWithProgress("ffmpeg", args, job.durationSeconds, (progress, pid) => {
      job.progress = progress;
      job.processPid = pid;
      job.message = "Running";
    });

    if (job.cancelled) {
      job.status = "cancelled";
      job.progress = 0;
      job.message = "Cancelled by user";
      await safeDeleteFile(job.outputFile);
    } else {
      job.status = "success";
      job.progress = 100;
      job.message = "Completed";
    }
  } catch (error) {
    if (job.cancelled) {
      job.status = "cancelled";
      job.progress = 0;
      job.message = "Cancelled by user";
      await safeDeleteFile(job.outputFile);
      return;
    }

    job.status = "failed";
    job.message = error instanceof Error ? error.message : "ffmpeg failed";
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      await worker(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => runWorker(),
  );
  await Promise.all(workers);
}

function runFfprobe(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ];
    const child = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

function runCommandWithProgress(
  command: string,
  args: string[],
  durationSeconds: number,
  onProgress: (progress: number, pid?: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    onProgress(0, child.pid);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const progress = getProgressFromFfmpegLine(text, durationSeconds);
      if (progress !== null) {
        onProgress(progress, child.pid);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

function getProgressFromFfmpegLine(text: string, durationSeconds: number): number | null {
  if (durationSeconds <= 0) {
    return null;
  }

  const matches = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
  const latest = matches?.at(-1);
  if (!latest) {
    return null;
  }

  const parts = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(latest);
  if (!parts) {
    return null;
  }

  const hours = Number(parts[1]);
  const minutes = Number(parts[2]);
  const seconds = Number(parts[3]);
  const currentSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.max(0, Math.min(99, Math.floor((currentSeconds / durationSeconds) * 100)));
}

async function startRun(run: ConversionRun) {
  await runWithConcurrency(run.jobs, run.concurrency, runConvertJob);
  run.isDone = true;
}

function serializeJobs(jobs: RuntimeJob[]): JobResult[] {
  return jobs.map((job) => ({
    jobId: job.jobId,
    inputFile: job.inputFile,
    outputFile: job.outputFile,
    status: job.status,
    progress: job.progress,
    message: job.message,
  }));
}

async function safeDeleteFile(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function createRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeSubtitlesPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

async function verifyBinaries() {
  await runCommand("ffmpeg", ["-version"]);
  await runCommand("ffprobe", ["-version"]);
}

verifyBinaries()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("ffmpeg/ffprobe check failed:", error);
    process.exit(1);
  });
