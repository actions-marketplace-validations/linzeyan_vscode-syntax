/**
 * Reference counts kept between sessions, one small JSON file per project.
 *
 * A count is a question for the language server, and the first one after a
 * window opens lands on a server that is still loading the project -- gopls on
 * a large module takes tens of seconds, and every lens waited that long. The
 * counts from last time are nearly always still right, so they are drawn at
 * once and asked again behind the drawing; a count that moved is redrawn when
 * the answer arrives.
 *
 * Never trusted without being checked, which is why nothing here invalidates:
 * no content hash, no watcher. A project changed while the window was closed
 * is corrected by the first look at each count, and a hash would only decide
 * whether a number that is about to be re-asked anyway is shown meanwhile.
 *
 * Small by construction: counts only, keyed by the path relative to the
 * project and the declaration key. Files that no longer exist are dropped when
 * the project is loaded, declarations a file no longer has are dropped when it
 * is counted, and a project nobody has opened for a month loses its file.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How long a project nobody opens keeps its file. */
const UNUSED_MS = 30 * 86_400_000;

/**
 * Where the files go: the daemon's cache root (`poly_tools::cache_dir`), so
 * everything poly keeps on this machine is under one directory.
 */
export function cacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // An empty XDG_CACHE_HOME counts as unset, as the spec says it should.
  const root = platform === "win32"
    ? env.LOCALAPPDATA || os.tmpdir()
    : env.XDG_CACHE_HOME || (env.HOME ? path.join(env.HOME, ".cache") : os.tmpdir());
  return path.join(root, "poly", "refs");
}

interface Snapshot {
  /** Per language, which questions its providers have answered: refs, down, up. */
  answers: Record<string, string[]>;
  /** Per file relative to the project, per lens key, the count. */
  files: Record<string, Record<string, number>>;
}

interface Project {
  file: string;
  data: Snapshot;
  dirty: boolean;
}

export class RefStore {
  private readonly projects = new Map<string, Project>();

  constructor(
    private readonly dir: string,
    private readonly exists: (file: string) => boolean = fs.existsSync,
    now: number = Date.now(),
  ) {
    sweep(dir, now);
  }

  /** The project's file: a name a person can recognise, and a hash so two `api` folders do not share one. */
  fileFor(folder: string): string {
    const hash = createHash("sha256").update(folder).digest("hex").slice(0, 12);
    return path.join(this.dir, `${path.basename(folder) || "root"}-${hash}.json`);
  }

  get(folder: string, file: string, key: string): number | undefined {
    const count = this.project(folder).data.files[file]?.[key];
    return typeof count === "number" ? count : undefined;
  }

  set(folder: string, file: string, key: string, count: number): void {
    const project = this.project(folder);
    const counts = (project.data.files[file] ??= {});
    if (counts[key] !== count) {
      counts[key] = count;
      project.dirty = true;
    }
  }

  /** Forget the keys a file no longer declares. */
  retain(folder: string, file: string, keys: ReadonlySet<string>): void {
    const project = this.project(folder);
    const counts = project.data.files[file];
    if (!counts) {
      return;
    }
    for (const key of Object.keys(counts)) {
      if (!keys.has(key)) {
        delete counts[key];
        project.dirty = true;
      }
    }
    if (Object.keys(counts).length === 0) {
      delete project.data.files[file];
    }
  }

  answered(folder: string, language: string): readonly string[] {
    return this.project(folder).data.answers[language] ?? [];
  }

  answer(folder: string, language: string, what: string): void {
    const project = this.project(folder);
    const said = (project.data.answers[language] ??= []);
    if (!said.includes(what)) {
      said.push(what);
      project.dirty = true;
    }
  }

  /**
   * Write every project that changed. Through a temporary file and a rename,
   * so a second window writing the same project leaves one of the two whole
   * rather than an interleaving of both.
   */
  save(): void {
    for (const project of this.projects.values()) {
      if (!project.dirty) {
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(project.file), { recursive: true });
        const temporary = `${project.file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(project.data));
        fs.renameSync(temporary, project.file);
        project.dirty = false;
      } catch {
        // A cache that cannot be written costs the next session its head
        // start, and nothing else.
      }
    }
  }

  private project(folder: string): Project {
    let project = this.projects.get(folder);
    if (project) {
      return project;
    }
    const file = this.fileFor(folder);
    const data: Snapshot = { answers: {}, files: {} };
    let dirty = false;
    try {
      const read = JSON.parse(fs.readFileSync(file, "utf8"));
      Object.assign(data.answers, read?.answers);
      Object.assign(data.files, read?.files);
      // Opened, so not unused: see `sweep`.
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // None yet, or unreadable. It is a cache: start empty.
    }
    for (const relative of Object.keys(data.files)) {
      if (!this.exists(path.join(folder, relative))) {
        delete data.files[relative];
        dirty = true;
      }
    }
    project = { file, data, dirty };
    this.projects.set(folder, project);
    return project;
  }
}

/** Delete the files of projects not opened for `UNUSED_MS`. */
function sweep(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > UNUSED_MS) {
        fs.rmSync(file);
      }
    } catch {
      // Gone already, or another window is sweeping too.
    }
  }
}
