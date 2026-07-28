import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  getFileSize: vi.fn(),
  listDirectory: vi.fn(),
  preprocessFile: vi.fn(),
  // The Rust-side `import_source_folder` invoke wrapper (exported from
  // @/commands/fs as `importSourceFolder`, aliased in source-lifecycle.ts).
  importSourceFolderCommand: vi.fn(),
  enqueueBatch: vi.fn(),
}))

vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    copyFile: mocks.copyFile,
    createDirectory: mocks.createDirectory,
    deleteFile: mocks.deleteFile,
    fileExists: mocks.fileExists,
    getFileSize: mocks.getFileSize,
    listDirectory: mocks.listDirectory,
    preprocessFile: mocks.preprocessFile,
    // Override the export named `importSourceFolder` (the invoke wrapper);
    // source-lifecycle.ts imports it as `importSourceFolderCommand`.
    importSourceFolder: mocks.importSourceFolderCommand,
  }
})

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: mocks.enqueueBatch,
}))

import {
  enqueueSourceIngest,
  folderContextForSourcePath,
  importSourceFiles,
  importSourceFolder,
  isIngestableSourcePath,
} from "./source-lifecycle"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.getFileSize.mockResolvedValue(1024)
  mocks.listDirectory.mockResolvedValue([])
  mocks.preprocessFile.mockResolvedValue("")
  mocks.importSourceFolderCommand.mockResolvedValue({ copied: [], failed: [] })
  mocks.enqueueBatch.mockResolvedValue(["task"])
})

describe("source-lifecycle path helpers", () => {
  it("does not treat preprocessed cache files as ingestable sources", () => {
    expect(isIngestableSourcePath("raw/sources/.cache/report.pdf.txt")).toBe(false)
    expect(isIngestableSourcePath("/project/raw/sources/.cache/report.pdf.txt")).toBe(false)
  })

  it("accepts supported ebook source formats", () => {
    expect(isIngestableSourcePath("raw/sources/book.epub")).toBe(true)
    expect(isIngestableSourcePath("C:\\project\\raw\\sources\\book.MOBI")).toBe(true)
  })

  it("derives folder context from absolute raw/sources paths without leaking the project prefix", () => {
    expect(
      folderContextForSourcePath("/tmp/project/raw/sources/reports/2026/report.pdf"),
    ).toBe("reports > 2026")
  })

  it("forwards the watch config and copied files to the Rust import command", async () => {
    mocks.importSourceFolderCommand.mockResolvedValue({
      copied: ["/project/raw/sources/imported/keep.md"],
      failed: [],
    })

    const result = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: ["json"],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(result.importedPaths).toEqual(["/project/raw/sources/imported/keep.md"])
    expect(result.failures).toEqual([])
    // The filtering now happens on the Rust side; the TS layer must forward
    // the normalized watch config (and the sensitive-config rule source) so
    // `import_source_folder` can mirror isSensitiveConfigSourceFile /
    // isPathAllowedBySourceWatch.
    expect(mocks.importSourceFolderCommand).toHaveBeenCalledWith(
      "/external/imported",
      "/project/raw/sources/imported",
      "imported",
      expect.objectContaining({
        includeHidden: true,
        maxBytes: 100 * 1024 * 1024,
        includeExtensions: ["md"],
        excludeExtensions: ["json"],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        sensitiveConfigDirs: expect.arrayContaining([".claude", ".codex", ".cursor", ".gemini", ".mcp"]),
        sensitiveConfigExtensions: expect.arrayContaining(["env", "json", "toml", "yaml", "yml", "xml"]),
      }),
    )
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.preprocessFile).toHaveBeenCalledOnce()
    expect(mocks.preprocessFile).toHaveBeenCalledWith("/project/raw/sources/imported/keep.md")
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/keep.md",
        folderContext: "imported",
      },
    ])
  })

  it("surfaces per-file copy failures returned by the Rust command without aborting ingest", async () => {
    mocks.importSourceFolderCommand.mockResolvedValue({
      copied: ["/project/raw/sources/imported/.claude/research.md"],
      failed: [
        { path: "/external/imported/.claude/settings.json", reason: "excluded" },
        { path: "/external/imported/.codex/config.yaml", reason: "excluded" },
      ],
    })

    const result = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["json", "yaml", "md"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(result.importedPaths).toEqual(["/project/raw/sources/imported/.claude/research.md"])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0].path).toBe("/external/imported/.claude/settings.json")
    // A failure must not abort ingest of the files that did copy.
    expect(mocks.enqueueBatch).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/.claude/research.md",
        folderContext: "imported > .claude",
      },
    ])
  })

  it("rejects importing the project folder or folders inside it", async () => {
    await expect(
      importSourceFolder(
        { id: "p1", name: "Project", path: "/project" },
        "/project",
        {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          apiKey: "key",
          model: "model",
          customModel: "",
          reasoning: { enabled: false, effort: "low" },
        } as never,
      ),
    ).rejects.toThrow("Cannot import the project folder")

    await expect(
      importSourceFolder(
        { id: "p1", name: "Project", path: "/project" },
        "/project/raw/sources",
        {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          apiKey: "key",
          model: "model",
          customModel: "",
          reasoning: { enabled: false, effort: "low" },
        } as never,
      ),
    ).rejects.toThrow("Cannot import the project folder")

    expect(mocks.importSourceFolderCommand).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("filters single-file imports using the original source path before copying", async () => {
    const copied = await importSourceFiles(
      { id: "p1", name: "Project", path: "/project" },
      ["/external/drafts/spec.md", "/external/ready.md"],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: [],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/ready.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith("/external/ready.md", "/project/raw/sources/ready.md")
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/drafts/spec.md", expect.anything())
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/ready.md",
        folderContext: "",
      },
    ])
  })

  it("allows an explicitly selected ebook with an older watch include-list", async () => {
    const copied = await importSourceFiles(
      { id: "p1", name: "Project", path: "/project" },
      ["/external/book.epub"],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md", "pdf"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/book.epub"])
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/external/book.epub",
      "/project/raw/sources/book.epub",
    )
  })

  it("skips sensitive tool config files at the shared ingest enqueue boundary", async () => {
    const queued = await enqueueSourceIngest(
      { id: "p1", name: "Project", path: "/project" },
      [
        "/project/raw/sources/.claude/settings.json",
        "/project/raw/sources/.codex/config.yaml",
        "/project/raw/sources/notes.md",
      ],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
    )

    expect(queued).toEqual(["task"])
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/notes.md",
        folderContext: "",
      },
    ])
  })

  it("naturally orders imported folder files before enqueueing ingest tasks", async () => {
    mocks.importSourceFolderCommand.mockResolvedValue({
      copied: [
        "/project/raw/sources/imported/10.md",
        "/project/raw/sources/imported/2.md",
        "/project/raw/sources/imported/1.md",
      ],
      failed: [],
    })

    const result = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(result.importedPaths).toEqual([
      "/project/raw/sources/imported/1.md",
      "/project/raw/sources/imported/2.md",
      "/project/raw/sources/imported/10.md",
    ])
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/1.md",
        folderContext: "imported",
      },
      {
        sourcePath: "/project/raw/sources/imported/2.md",
        folderContext: "imported",
      },
      {
        sourcePath: "/project/raw/sources/imported/10.md",
        folderContext: "imported",
      },
    ])
  })
})
