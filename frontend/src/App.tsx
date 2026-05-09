import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Stream = {
  index: number;
  codecType: string;
  codecName?: string;
  language?: string;
  title?: string;
};

type VideoFile = {
  inputFile: string;
  fileName: string;
  streams: Stream[];
};

type Selection = {
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
};

type ConvertResult = {
  jobId: string;
  inputFile: string;
  outputFile: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  progress: number;
  message: string;
};

function App() {
  const [folderPath, setFolderPath] = useState("");
  const [files, setFiles] = useState<VideoFile[]>([]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [concurrency, setConcurrency] = useState(3);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ConvertResult[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [applyAudioIndex, setApplyAudioIndex] = useState<number | "">("");
  const [applySubtitleIndex, setApplySubtitleIndex] = useState<number | "">("");

  const allAudioOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const file of files) {
      for (const stream of file.streams) {
        if (stream.codecType !== "audio") {
          continue;
        }
        if (!map.has(stream.index)) {
          map.set(
            stream.index,
            `#${stream.index} ${stream.language ?? "und"} ${stream.codecName ?? ""}`.trim(),
          );
        }
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, label]) => ({ index, label }));
  }, [files]);

  const allSubtitleOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const file of files) {
      for (const stream of file.streams) {
        if (stream.codecType !== "subtitle") {
          continue;
        }
        if (!map.has(stream.index)) {
          map.set(
            stream.index,
            `#${stream.index} ${stream.language ?? "und"} ${stream.codecName ?? ""}`.trim(),
          );
        }
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, label]) => ({ index, label }));
  }, [files]);

  const onScan = async () => {
    setError("");
    setResults([]);
    setRunId(null);
    setConverting(false);
    setLoading(true);
    try {
      const response = await fetch("/api/scan-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Scan failed");
      }

      setFiles(payload.files);
      const nextSelections: Record<string, Selection> = {};
      for (const file of payload.files as VideoFile[]) {
        const firstAudio = file.streams.find((stream) => stream.codecType === "audio");
        const firstSubtitle = file.streams.find((stream) => stream.codecType === "subtitle");
        nextSelections[file.inputFile] = {
          audioStreamIndex: firstAudio?.index,
          subtitleStreamIndex: firstSubtitle?.index,
        };
      }
      setSelections(nextSelections);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Failed to scan");
    } finally {
      setLoading(false);
    }
  };

  const onConvert = async () => {
    setError("");
    setResults([]);
    try {
      const jobs = files.map((file) => {
        const selection = selections[file.inputFile];
        if (
          selection?.audioStreamIndex === undefined ||
          selection?.subtitleStreamIndex === undefined
        ) {
          throw new Error(`Choose both audio and subtitle for ${file.fileName}`);
        }

        return {
          inputFile: file.inputFile,
          outputFile: buildOutputPath(file.inputFile),
          audioStreamIndex: selection.audioStreamIndex,
          subtitleStreamIndex: selection.subtitleStreamIndex,
        };
      });

      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs, concurrency }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Conversion failed");
      }
      setRunId(payload.runId);
      setResults(payload.results);
      setConverting(true);
    } catch (convertError) {
      setError(convertError instanceof Error ? convertError.message : "Failed to convert");
      setConverting(false);
    }
  };

  useEffect(() => {
    if (!runId) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/convert/status/${runId}`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to fetch status");
        }
        setResults(payload.results);
        if (payload.isDone) {
          setConverting(false);
          setRunId(null);
        }
      } catch (statusError) {
        setError(statusError instanceof Error ? statusError.message : "Failed to fetch status");
        setConverting(false);
        setRunId(null);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [runId]);

  const onCancelJob = async (jobId: string) => {
    if (!runId) {
      return;
    }
    try {
      const response = await fetch("/api/convert/cancel-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, jobId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to cancel job");
      }
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Failed to cancel job");
    }
  };

  const applySelectedAudioToAll = () => {
    if (applyAudioIndex === "") {
      return;
    }
    const next = { ...selections };
    for (const file of files) {
      const hasAudio = file.streams.some(
        (stream) => stream.codecType === "audio" && stream.index === applyAudioIndex,
      );
      if (hasAudio) {
        next[file.inputFile] = { ...next[file.inputFile], audioStreamIndex: applyAudioIndex };
      }
    }
    setSelections(next);
  };

  const applySelectedSubtitleToAll = () => {
    if (applySubtitleIndex === "") {
      return;
    }
    const next = { ...selections };
    for (const file of files) {
      const hasSubtitle = file.streams.some(
        (stream) => stream.codecType === "subtitle" && stream.index === applySubtitleIndex,
      );
      if (hasSubtitle) {
        next[file.inputFile] = {
          ...next[file.inputFile],
          subtitleStreamIndex: applySubtitleIndex,
        };
      }
    }
    setSelections(next);
  };

  return (
    <main className="page">
      <h1>MKV to MP4 (Burn Subtitle)</h1>
      <p className="muted">
        Uses local ffmpeg/ffprobe from backend. Provide folder path containing MKV files.
      </p>

      <section className="panel">
        <label className="field">
          Folder path
          <input
            type="text"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            placeholder="/absolute/path/to/folder"
          />
        </label>

        <div className="dropHint">
          Drag/drop is visual only in browser mode. If drop does not fill path, paste the full
          folder path manually.
        </div>

        <div className="row">
          <label className="field small">
            Concurrency (1-6)
            <input
              type="number"
              min={1}
              max={6}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value || 1))}
            />
          </label>
          <button type="button" onClick={onScan} disabled={loading || !folderPath.trim()}>
            {loading ? "Scanning..." : "Scan Folder"}
          </button>
          <button type="button" onClick={onConvert} disabled={converting || files.length === 0}>
            {converting ? "Converting..." : "Convert"}
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      {files.length > 0 && (
        <section className="panel">
          <div className="row">
            <h2>Files ({files.length})</h2>
            <label className="field small">
              Apply audio to all
              <select
                value={applyAudioIndex}
                onChange={(event) =>
                  setApplyAudioIndex(event.target.value === "" ? "" : Number(event.target.value))
                }
              >
                <option value="">Select audio</option>
                {allAudioOptions.map((option) => (
                  <option key={option.index} value={option.index}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={applySelectedAudioToAll} disabled={applyAudioIndex === ""}>
              Apply audio
            </button>
            <label className="field small">
              Apply subtitle to all
              <select
                value={applySubtitleIndex}
                onChange={(event) =>
                  setApplySubtitleIndex(
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
              >
                <option value="">Select subtitle</option>
                {allSubtitleOptions.map((option) => (
                  <option key={option.index} value={option.index}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={applySelectedSubtitleToAll}
              disabled={applySubtitleIndex === ""}
            >
              Apply subtitle
            </button>
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Audio</th>
                  <th>Subtitle (Burn)</th>
                  <th>Progress</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const audioStreams = file.streams.filter((stream) => stream.codecType === "audio");
                  const subtitleStreams = file.streams.filter(
                    (stream) => stream.codecType === "subtitle",
                  );
                  const current = selections[file.inputFile] ?? {};
                  const result = results.find((item) => item.inputFile === file.inputFile);
                  return (
                    <tr key={file.inputFile}>
                      <td className="fileCell">{file.fileName}</td>
                      <td>
                        <select
                          value={current.audioStreamIndex ?? ""}
                          onChange={(event) => {
                            setSelections((prev) => ({
                              ...prev,
                              [file.inputFile]: {
                                ...prev[file.inputFile],
                                audioStreamIndex: Number(event.target.value),
                              },
                            }));
                          }}
                        >
                          {audioStreams.map((stream) => (
                            <option key={stream.index} value={stream.index}>
                              #{stream.index} {stream.language ?? "und"} {stream.codecName ?? ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={current.subtitleStreamIndex ?? ""}
                          onChange={(event) => {
                            setSelections((prev) => ({
                              ...prev,
                              [file.inputFile]: {
                                ...prev[file.inputFile],
                                subtitleStreamIndex: Number(event.target.value),
                              },
                            }));
                          }}
                        >
                          {subtitleStreams.map((stream) => (
                            <option key={stream.index} value={stream.index}>
                              #{stream.index} {stream.language ?? "und"} {stream.codecName ?? ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {result ? (
                          <>
                            <div>{result.status.toUpperCase()}</div>
                            <progress max={100} value={result.progress} />
                            <div>{result.progress}%</div>
                          </>
                        ) : (
                          "Not started"
                        )}
                      </td>
                      <td>
                        {result && (result.status === "queued" || result.status === "running") ? (
                          <button type="button" onClick={() => onCancelJob(result.jobId)}>
                            Cancel
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function buildOutputPath(inputFile: string): string {
  const normalized = inputFile.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = normalized.slice(0, lastSlash);
  const fileName = normalized.slice(lastSlash + 1);
  const outputName = fileName.replace(/\.mkv$/i, ".mp4");
  return `${dir}/output/${outputName}`;
}

export default App;
