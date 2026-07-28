# 修复:Ubuntu 导入含中文文件夹失败

## 根因
1. **`build_tree`**(src-tauri/src/commands/fs.rs:1467-1532)在 Linux 上 `file_name().to_str()` 对非 UTF-8 字节(典型:从 Windows 中文系统拷贝的 GBK 文件名)返回 `None` → `:1480-1486` 的过滤器 `unwrap_or(false)` **静默丢弃**条目;`:1503` name 退化为空串;`:1509` `to_string_lossy()` 把路径污染为 U+FFFD。前端 `importSourceFolder` 经 `listDirectory`(source-lifecycle.ts:329)拿到空/错路径列表,后续 `copyFile` → `fs::copy` 因路径与真实文件不匹配而 `No such file or directory`。
2. **`importSourceFolder`**(source-lifecycle.ts:349)`await copyFile(...)` **无 per-file try/catch**(对照 `importSourceFiles:286-301` 有容错),一个文件失败就让整次 reject。
3. **`handleImportFolder`**(sources-view.tsx:168-169)只 `console.error`,用户无可见反馈。
4. 同源风险:`api_server.rs:push_file_node`(967-979)同样 `to_str` 模式;`scheduled-import.ts:378` 复用 `listDirectory`。

核心矛盾:前端 IPC 是 UTF-8 字符串,Linux 文件名可是任意字节(GBK)。**根治的唯一出路是让"遍历+复制"在 Rust 端用原始 `OsStr` 字节完成、不经前端字符串往返**——已有 `copy_directory`(fs.rs:1554-1609,`:1584-1585` 用 `entry.file_name()` 原始 OsString `dest.join(&name)`)正是此模式,可作蓝本。

## 方案(彻底修复,对 UTF-8 与 GBK 都有效)

### 第 1 层 — Rust 端根治 GBK 复制(核心)
新增命令 `import_source_folder`(src-tauri/src/commands/fs.rs,基于 `copy_directory` 模式扩展):

```rust
#[derive(Serialize)]
pub struct ImportFailure { pub path: String, pub reason: String }
#[derive(Serialize)]
pub struct ImportFolderResult { pub copied: Vec<String>, pub failed: Vec<ImportFailure> }
#[derive(Deserialize)]
pub struct ImportFilterConfig {
    pub include_hidden: bool,
    pub max_bytes: u64,
    pub include_extensions: Vec<String>,   // 已小写、去前导点
    pub exclude_extensions: Vec<String>,
    pub exclude_dirs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub sensitive_config_dirs: Vec<String>,
    pub sensitive_config_extensions: Vec<String>,
}

#[tauri::command]
pub async fn import_source_folder(
    source: String,
    destination: String,
    config: ImportFilterConfig,
) -> Result<ImportFolderResult, String>
```

行为(`spawn_blocking` + `run_guarded`,参考 `copy_directory:1554-1609`):
- 递归遍历 `source`,**用 `entry.file_name()`(原始 OsString)`dest.join(&name)` 拼目标路径**(不经前端字符串 → GBK 源也能读)。
- 用 `to_string_lossy()` 路径做过滤(复刻 TS 语义):
  - 隐藏:`config.include_hidden || !name.starts_with('.')`(注意:`copy_directory` 现硬编码跳 dot,新命令改成参数控制,匹配 `importSourceFolder` 现传 `includeHidden:true`)。
  - 敏感配置:路径任一段 ∈ `sensitive_config_dirs` 且 ext ∈ `sensitive_config_extensions` → 跳过(不复制,不计失败)。复刻 `isSensitiveConfigSourceFile`(source-filter.ts:31-40)。
  - `exclude_dirs`/`exclude_globs` 命中 → 跳过。`exclude_globs` 用手写 `glob_match(pattern, path)`(支持 `*`→任意序列、`?`→单字符、转义其他正则元字符、大小写不敏感、整体匹配 name 或 full path),等价于 TS `wildcardToRegExp`+`matchesGlob`(source-watch-config.ts:62-75)。**不引入 regex crate**。
  - ext ∈ `exclude_extensions` → 跳过;`include_extensions` 非空且 ext 不在其中 → 跳过。
  - `fs::metadata().len() > max_bytes` → 记 `failed`(reason "exceeds size limit"),不复制。
- 复制 `fs::copy(&path, &dest_path)`,**per-file 容错**:失败记入 `failed`(reason = io error),`continue`,不 abort。
- 成功:`file_sync::mark_app_write_path(&dest_path)`,`copied.push(dest_path.to_string_lossy().replace('\\','/'))`。
- 目录:递归(`create_dir_all`),与 `copy_directory` 一致。
- 返回 `ImportFolderResult`。
- 注册到 `generate_handler!`(src-tauri/src/lib.rs:629-635 那块)。

### 第 2 层 — 前端流程改造
`src/commands/fs.ts`:新增 `importSourceFolder(source, destination, config)` → `invoke<ImportFolderResult>("import_source_folder", {...})`。

`src/lib/source-lifecycle.ts:309-364` `importSourceFolder` 改为:
- 保留 `isProjectScopedImport` 检查(`:317-318`)、`folderName`/`destDir` 计算(`:320-321`)。
- 组装 `ImportFilterConfig`:`include_hidden:true`;`max_bytes = cfg.maxFileSizeMb*1024*1024`;include/exclude extensions、exclude_dirs、exclude_globs 取自 `normalizeSourceWatchConfig(sourceWatchConfig)`;`sensitive_config_dirs`/`sensitive_config_extensions` 从 `source-filter.ts` **导出** `SENSITIVE_CONFIG_DIR_NAMES`/`SENSITIVE_CONFIG_EXTENSIONS`(现为模块私有,加 export)传入,配置单一来源在前端。
- 调 `importSourceFolder(sourceRoot, destDir, config)` → `{ copied, failed }`。
- `copied` 自然排序(`:354-356` 逻辑保留)→ `enqueueSourceIngest(project, copied, llmConfig, { sourceRoot: destDir, rootContext: folderName })`(`enqueueSourceIngest:239` 内部已对目标 UTF-8 路径做 `isIngestableSourcePath + isSensitiveConfigSourceFile` 二次过滤,无需在新命令重复 ingestable 集合)。
- 返回 `{ importedPaths: copied, failures: failed }`(改返回类型,供 UI 展示失败)。
- 删除原逐文件 `copyFile` 循环(`:331-352`),不再经 `listDirectory` 取源列表。

### 第 3 层 — 用户可见的错误反馈
`src/components/sources/sources-view.tsx`:
- 新增 `importError` state(string|null)。
- `handleImportFolder`(`:154-173`):`catch` 或 `failures.length>0` 时 `setImportError(...)`,文案"成功 N 个,失败 M 个"+ 失败文件名列表(截断前 ~10 个)。
- 复用 `:369-376` 的 inline destructive banner 模式渲染 `importError`(不引入 toast 库,与项目现状一致)。
- i18n:加 `sources.importFolderPartialFailed`/`sources.importFolderFailed` 文案于 `src/i18n/`(zh/en/ja/ko)。

### 第 4 层 — 同源一致性修复(建议同批,低风险)
- **`build_tree`**(fs.rs:1480-1486):可见性过滤改用 `entry.file_name().to_string_lossy()`(不再 `to_str().unwrap_or(false)` 丢非 UTF-8 文件);`:1503` name、`:1509` path 继续用 `to_string_lossy`(对 UTF-8 中文无损)。这让"原始资料"列表展示非 UTF-8 文件(名乱码但不消失)。复制已由第 1 层根治,此处仅改展示。
- **`api_server.rs:push_file_node`**(975-979):同样改 `to_string_lossy`,保持 HTTP 远程访问一致。
- **`scheduled-import.ts:378`**:可改调新 `import_source_folder` 命令(同源受益);或至少在第 4 层 `build_tree` 修复后不再丢文件。列为可选。

## 测试
- Rust 单测:用 `tempfile`(若已在 dev-deps;否则加)构造含 GBK 字节文件名(`OsString::from_vec(vec![0xC4, 0xE3, ...])`)的临时目录,断言 `build_tree` 返回非空(不丢文件)、`import_source_folder` `copied` 非空(复制成功)。
- TS:`src/lib/source-lifecycle.test.ts` 补 `importSourceFolder` 用例(mock `invoke` 返回 `{copied, failed}`,断言 `enqueueSourceIngest` 收到正确路径、失败透传)。
- 手测:Ubuntu 上选一个含中文(UTF-8 与 GBK 各一)文件夹导入,确认成功 + 失败有可见提示。

## 风险与取舍
- 过滤逻辑 TS/Rust 两份:`source-filter.ts`/`source-watch-config.ts` 与新 Rust 命令镜像,需注释标明"镜像关系"并保持同步。
- 手写 `glob_match` 须与 TS `wildcardToRegExp` 等价(覆盖 `*`/`?`/元字符转义/大小写不敏感)。
- GBK 源的目标文件名是 U+FFFD 乱码(可接受:至少导入成功、可 ingest);可选后续引入 `encoding_rs` 做 GBK→UTF-8 文件名转码让名正确——**本次不引入新依赖**。
- `importSourceFolder` 返回类型变化:需检查调用方(sources-view.tsx:166)同步调整。

## 落地顺序
1. 第 1 层(新 Rust 命令)+ 注册 → `cargo check`。
2. 第 2 层(前端流程)+ 第 3 层(UI/i18n)→ `npm run build`/lint。
3. 第 4 层(同源修复)→ 回归。
4. 测试补齐。
5. 手测验证(UTF-8 + GBK 两个文件夹)。