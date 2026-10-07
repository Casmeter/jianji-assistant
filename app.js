/* 快速切片小工具 */
const $ = (id) => document.getElementById(id);
const VIDEO = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);

let project = null;
let selectedLine = null;
let playerEpisode = null;
let inPoint = null;
let outPoint = null;
let saveTimer = 0;
let resumeHandle = null;
let cutting = false;
let mediaKit = null;

const episodesEl = $("episodes");
const scriptEl = $("script");
const player = $("player");
const stage = $("stage");

function boot() {
  $("open-folder").onclick = () => pickFolder();
  $("gate-folder").onclick = () => pickFolder();
  $("open-file").onclick = () => $("file-input").click();
  $("gate-file").onclick = () => $("file-input").click();
  $("dir-input").onchange = () => takeFiles($("dir-input").files, directoryTitle($("dir-input").files));
  $("file-input").onchange = () => takeFiles($("file-input").files, fileTitle($("file-input").files));
  $("export-table").onclick = exportTable;
  $("export-clips").onclick = exportClips;
  $("export-subs").onclick = exportSubs;
  $("set-in").onclick = () => setPoint("in");
  $("set-out").onclick = () => setPoint("out");
  $("fs-in").onclick = () => setPoint("in");
  $("fs-out").onclick = () => setPoint("out");
  $("attach").onclick = attach;
  $("fs-attach").onclick = attach;
  $("go-full").onclick = enterFull;
  $("exit-full").onclick = () => document.exitFullscreen();
  $("in-point").onchange = () => readPoint("in");
  $("out-point").onchange = () => readPoint("out");
  $("composer").onsubmit = (event) => {
    event.preventDefault();
    addLine();
  };
  $("draft").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addLine();
    }
  };
  player.ontimeupdate = () => {
    const clock = formatClock(player.currentTime || 0);
    $("clock").textContent = clock;
    $("theater-clock").textContent = clock;
  };
  player.onerror = () => setStatus("这个格式在页面里放不了。可以手填时间码，下载切片清单后交给剪映。");
  document.addEventListener("keydown", onKey);
  episodesEl.addEventListener("click", onEpisodeClick);
  scriptEl.addEventListener("click", onScriptClick);
  scriptEl.addEventListener("input", onScriptInput);
  scriptEl.addEventListener("dragstart", onDragStart);
  scriptEl.addEventListener("dragover", onDragOver);
  scriptEl.addEventListener("drop", onDrop);
  episodesEl.addEventListener("dragstart", onDragStart);
  episodesEl.addEventListener("dragover", onDragOver);
  episodesEl.addEventListener("drop", onDrop);
  episodesEl.addEventListener("dragend", onDragEnd);
  scriptEl.addEventListener("dragend", onDragEnd);
  $("axis-track").addEventListener("click", onAxisClick);
  bindSplits();
  window.addEventListener("pagehide", saveNow);
  render();
  recallFolder();
  showLastHint();
}

async function pickFolder() {
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await storeHandle(handle);
      await readDirectory(handle);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      $("dir-input").click();
    }
    return;
  }
  $("dir-input").click();
}

async function readDirectory(handle) {
  const files = [];
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && isVideo(entry.name)) files.push(await entry.getFile());
  }
  await takeFiles(files, handle.name);
}

async function takeFiles(list, title) {
  const files = [...list].filter((file) => isVideo(file.name));
  $("dir-input").value = "";
  $("file-input").value = "";
  if (!files.length) {
    setStatus("这个位置没有 mp4、mov、mkv、webm 或 avi。");
    return;
  }
  files.sort((a, b) => naturalCompare(a.name, b.name));
  const episodes = files.map((file) => ({
    id: digest(`${file.name}\0${file.size}\0${file.lastModified}`),
    name: file.name,
    size: file.size,
    mtime: file.lastModified,
    file,
    url: URL.createObjectURL(file),
  }));
  const signature = digest(episodes.map((item) => item.id).sort().join("|"));
  const saved = loadBoard(signature);
  const order = new Map((saved && saved.episodeOrder || []).map((id, index) => [id, index]));
  episodes.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1000) - (order.has(b.id) ? order.get(b.id) : 1000) || naturalCompare(a.name, b.name));
  revokeUrls();
  project = {
    title: title || stem(files[0].name),
    signature,
    episodes,
    lines: saved && Array.isArray(saved.lines) ? saved.lines : [],
  };
  selectedLine = project.lines[0] ? project.lines[0].id : null;
  playerEpisode = null;
  player.removeAttribute("src");
  stage.classList.remove("ready");
  render();
  saveNow();
  setStatus(saved ? `已接上「${project.title}」里写过的句子。视频仍在你的电脑上。` : `已打开 ${project.title}。视频不会上传。`);
}

function render() {
  const ready = Boolean(project);
  $("gate").hidden = ready;
  $("export-table").disabled = !ready;
  $("export-clips").disabled = !ready || cutting;
  $("export-subs").disabled = !ready;
  $("composer").hidden = !ready;
  $("workspace").textContent = ready ? project.title : "还没有原片";
  renderEpisodes();
  renderScript();
  renderAxis();
  renderPoints();
}

function renderEpisodes() {
  $("episode-count").textContent = project ? String(project.episodes.length) : "0";
  if (!project || !project.episodes.length) {
    episodesEl.innerHTML = '<p class="empty">打开后按文件名排成 01、02。按住卡片拖动，也可以点上移、下移。</p>';
    return;
  }
  episodesEl.innerHTML = project.episodes.map((episode, index) => {
    const on = episode.id === playerEpisode ? " selected" : "";
    return `<li class="row${on}" data-id="${episode.id}" draggable="true">
      <span class="num">${pad(index + 1)}</span>
      <div class="row-body">
        <p class="row-title">${escapeHtml(episode.name)}</p>
        <div class="row-actions">
          <button type="button" data-act="up">上移</button>
          <button type="button" data-act="down">下移</button>
        </div>
      </div>
    </li>`;
  }).join("");
}

function renderScript() {
  $("line-count").textContent = project ? String(project.lines.length) : "0";
  if (!project) {
    scriptEl.innerHTML = '<p class="empty">这里的顺序就是切片顺序。不写字也能加一段。勾选「只作备忘」的不会进可选字幕。</p>';
    return;
  }
  if (!project.lines.length) {
    scriptEl.innerHTML = '<p class="empty">写下第一句口播，或留空只加一段切片。上面是 01，下面接着 02。</p>';
    return;
  }
  scriptEl.innerHTML = project.lines.map((line, index) => {
    const on = line.id === selectedLine ? " selected" : "";
    const memo = line.memo ? " memo" : "";
    return `<li class="row${on}${memo}" data-id="${line.id}" draggable="true">
      <span class="num">${pad(index + 1)}</span>
      <div class="row-body">
        <textarea class="line-text" rows="2" placeholder="无字切片，只标出入点">${escapeHtml(line.text)}</textarea>
        <p class="${line.episodeId ? "meta ok" : "meta"}">${clipLabel(line)}</p>
        <label class="memo-toggle"><input type="checkbox" data-act="memo"${line.memo ? " checked" : ""} /> 只作备忘</label>
        <div class="row-actions">
          <button type="button" data-act="up">上移</button>
          <button type="button" data-act="down">下移</button>
          <button type="button" data-act="del">删除</button>
        </div>
      </div>
    </li>`;
  }).join("");
}

function renderAxis() {
  const track = $("axis-track");
  const { blocks, total, missing } = timeline(project);
  $("axis-total").textContent = formatClock(total);
  if (!blocks.length) {
    track.innerHTML = "";
    $("axis-note").textContent = "标好出入点后，切片会按这个顺序接起来。";
    return;
  }
  track.innerHTML = blocks.map((block) => {
    const selected = block.line.id === selectedLine ? " selected" : "";
    const memo = block.line.memo ? " memo" : "";
    return `<button type="button" class="axis-block${memo}${selected}" data-id="${block.line.id}" style="flex-grow:${Math.max(block.duration, 0.4)}" title="${formatClock(block.start)}–${formatClock(block.end)}">${pad(block.index)}</button>`;
  }).join("");
  const spare = missing ? ` ${missing} 段还没贴画面。` : "";
  $("axis-note").textContent = `切片总长 ${formatClock(total)}。这是切片顺序，不是字幕轴。空心的是备忘。${spare}`;
}

function renderPoints() {
  $("in-point").value = inPoint == null ? "" : formatClock(inPoint);
  $("out-point").value = outPoint == null ? "" : formatClock(outPoint);
  if (inPoint == null || outPoint == null || outPoint <= inPoint) {
    $("span").textContent = "—";
    $("fs-span").textContent = "—";
  } else {
    const length = formatClock(outPoint - inPoint);
    $("span").textContent = length;
    $("fs-span").textContent = length;
  }
}

function onEpisodeClick(event) {
  const row = event.target.closest(".row");
  if (!row || !project) return;
  const id = row.dataset.id;
  const act = event.target.dataset.act;
  if (act === "up" || act === "down") {
    move(project.episodes, id, act === "up" ? -1 : 1);
    renderEpisodes();
    renderScript();
    scheduleSave();
    return;
  }
  playEpisode(id, 0);
}

function playEpisode(id, time) {
  const episode = project.episodes.find((item) => item.id === id);
  if (!episode) return;
  playerEpisode = id;
  if (player.dataset.episode !== id) {
    player.src = episode.url;
    player.dataset.episode = id;
    player.addEventListener("loadedmetadata", () => {
      if (time) player.currentTime = time;
    }, { once: true });
  } else if (time) {
    player.currentTime = time;
  }
  stage.classList.add("ready");
  renderEpisodes();
  setStatus(`正在看 ${episode.name}。I 记入点，O 记出点。`);
}

function onScriptClick(event) {
  const row = event.target.closest(".row");
  if (!row || !project) return;
  const id = row.dataset.id;
  const act = event.target.dataset.act;
  if (act === "up" || act === "down") {
    move(project.lines, id, act === "up" ? -1 : 1);
    selectedLine = id;
    renderScript();
    renderAxis();
    scheduleSave();
    return;
  }
  if (act === "memo") {
    const line = project.lines.find((item) => item.id === id);
    if (!line) return;
    line.memo = event.target.checked;
    row.classList.toggle("memo", line.memo);
    selectedLine = id;
    markSelected(scriptEl, id);
    renderAxis();
    scheduleSave();
    return;
  }
  if (act === "del") {
    project.lines = project.lines.filter((line) => line.id !== id);
    if (selectedLine === id) selectedLine = project.lines[0] ? project.lines[0].id : null;
    renderScript();
    renderAxis();
    scheduleSave();
    return;
  }
  chooseLine(id, event.target.classList.contains("line-text"));
}

function onAxisClick(event) {
  const block = event.target.closest(".axis-block");
  if (!block || !project) return;
  chooseLine(block.dataset.id, false);
}

function chooseLine(id, keepFocus) {
  selectedLine = id;
  const line = project.lines.find((item) => item.id === id);
  if (line && line.episodeId) {
    inPoint = line.start;
    outPoint = line.end;
    playEpisode(line.episodeId, line.start || 0);
    renderPoints();
  }
  if (keepFocus) {
    markSelected(scriptEl, id);
    renderAxis();
    return;
  }
  renderScript();
  renderAxis();
}

function onScriptInput(event) {
  if (!event.target.classList.contains("line-text") || !project) return;
  const row = event.target.closest(".row");
  const line = project.lines.find((item) => item.id === row.dataset.id);
  if (!line) return;
  line.text = event.target.value;
  scheduleSave();
}

function addLine() {
  if (!project) {
    setStatus("先选择文件夹或视频。");
    return;
  }
  const text = $("draft").value.trim();
  const line = { id: uid(), text, memo: false, episodeId: null, start: null, end: null };
  project.lines.push(line);
  selectedLine = line.id;
  $("draft").value = "";
  renderScript();
  renderAxis();
  scheduleSave();
  setStatus(text ? `已写上第 ${pad(project.lines.length)} 句口播。` : `已加上第 ${pad(project.lines.length)} 段无字切片。`);
}

function setPoint(which) {
  if (!player.src) {
    setStatus("先从左边点开一集。");
    return;
  }
  const time = player.currentTime || 0;
  if (which === "in") inPoint = time;
  else outPoint = time;
  renderPoints();
}

function readPoint(which) {
  const value = parseClock($(which === "in" ? "in-point" : "out-point").value);
  if (value == null) return;
  if (which === "in") inPoint = value;
  else outPoint = value;
  renderPoints();
}

function attach() {
  readPoint("in");
  readPoint("out");
  if (!project || !selectedLine) {
    setStatus("先在中间选中一段。");
    return;
  }
  if (!playerEpisode || inPoint == null || outPoint == null || outPoint <= inPoint) {
    setStatus("入点要早于出点。用 I 和 O，或直接填写时间。");
    return;
  }
  const line = project.lines.find((item) => item.id === selectedLine);
  line.episodeId = playerEpisode;
  line.start = round(inPoint);
  line.end = round(outPoint);
  renderScript();
  renderAxis();
  scheduleSave();
  const block = timeline(project).blocks.find((item) => item.line.id === line.id);
  const index = project.lines.findIndex((item) => item.id === selectedLine) + 1;
  const placed = block ? `切片顺序 ${formatClock(block.start)}–${formatClock(block.end)}` : "";
  setStatus(`第 ${pad(index)} 段已贴上画面。${placed}`);
}

function onKey(event) {
  if (event.target.matches("textarea, input")) return;
  if (event.key === "i" || event.key === "I") setPoint("in");
  if (event.key === "o" || event.key === "O") setPoint("out");
}

function onDragStart(event) {
  const row = event.target.closest(".row");
  if (!row) return;
  if (event.target.closest("textarea, input, button, label")) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData("text/plain", `${event.currentTarget.id}:${row.dataset.id}`);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("drag");
}

function onDragEnd(event) {
  const row = event.target.closest(".row");
  if (row) row.classList.remove("drag");
}

function onDragOver(event) {
  const row = event.target.closest(".row");
  if (!row || row.parentElement !== event.currentTarget) return;
  event.preventDefault();
}

function onDrop(event) {
  const row = event.target.closest(".row");
  if (!row || !project) return;
  event.preventDefault();
  const [listId, sourceId] = (event.dataTransfer.getData("text/plain") || "").split(":");
  if (listId !== event.currentTarget.id) return;
  const list = listId === "episodes" ? project.episodes : project.lines;
  const from = list.findIndex((item) => item.id === sourceId);
  const to = list.findIndex((item) => item.id === row.dataset.id);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  if (listId === "episodes") renderEpisodes();
  renderScript();
  renderAxis();
  scheduleSave();
}

async function exportClips() {
  if (!project || cutting) return;
  const jobs = [];
  project.lines.forEach((line, index) => {
    const episode = project.episodes.find((item) => item.id === line.episodeId && item.file);
    if (!episode || line.start == null || line.end == null || line.end <= line.start) return;
    jobs.push({ line, index, episode });
  });
  if (!jobs.length) {
    setStatus("先给要切的段标好入点和出点。");
    return;
  }
  let dir = null;
  if (window.showDirectoryPicker) {
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite", id: "jianji-slices" });
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("没有选择保存位置。");
        return;
      }
    }
  }
  cutting = true;
  $("export-clips").disabled = true;
  try {
    const kit = await loadMediaKit();
    const clips = [];
    let saved = 0;
    let failed = 0;
    for (const job of jobs) {
      const name = `${pad(job.index + 1)}.mp4`;
      setStatus(`正在切第 ${name.slice(0, 2)} 段，共 ${jobs.length} 段。只读取这一段，原片不会上传。`);
      try {
        if (dir) {
          await cutToDirectory(kit, dir, name, job.episode.file, job.line.start, job.line.end);
          saved += 1;
        } else {
          clips.push({ name, data: await cutToBuffer(kit, job.episode.file, job.line.start, job.line.end) });
        }
      } catch (error) {
        failed += 1;
      }
    }
    const miss = failed ? `有 ${failed} 段没切成。` : "";
    if (dir) {
      setStatus(saved ? `已保存 ${saved} 段切片。${miss}` : `没有切出来。${miss}换成 mp4，或把片段稍稍拉长。`);
      return;
    }
    if (!clips.length) {
      setStatus(`没有切出来。${miss}换成 mp4，或把片段稍稍拉长。`);
      return;
    }
    downloadBlob("切片.zip", zipStore(clips));
    setStatus(`已开始下载 ${clips.length} 段切片。${miss}`);
  } catch (error) {
    setStatus("切片工具没有载入。刷新页面后再试一次。");
  } finally {
    cutting = false;
    if (project) $("export-clips").disabled = false;
  }
}

async function loadMediaKit() {
  if (!mediaKit) mediaKit = await import("./vendor/mediabunny/mediabunny.min.mjs");
  return mediaKit;
}

async function cutClip(kit, file, start, end, target) {
  const input = new kit.Input({
    source: new kit.BlobSource(file),
    formats: kit.ALL_FORMATS,
  });
  try {
    const output = new kit.Output({
      format: new kit.Mp4OutputFormat(),
      target,
    });
    const conversion = await kit.Conversion.init({
      input,
      output,
      trim: { start, end },
      copy: {
        mode: "preferred",
        boundaryPolicy: "expand",
        boundaryTolerance: Infinity,
        shiftTolerance: Infinity,
      },
    });
    if (!conversion.isValid) throw new Error("invalid");
    await conversion.execute();
  } finally {
    if (typeof input.dispose === "function") await input.dispose();
  }
}

async function cutToDirectory(kit, dir, name, file, start, end) {
  const handle = await dir.getFileHandle(name, { create: true });
  const sink = await handle.createWritable();
  let closed = false;
  const closeSink = async (abort) => {
    if (closed) return;
    closed = true;
    if (abort) await sink.abort();
    else await sink.close();
  };
  const stream = new WritableStream({
    async write(chunk) {
      const data = new Uint8Array(chunk.data.byteLength);
      data.set(chunk.data);
      await sink.write({ type: "write", position: chunk.position, data });
    },
    close() { return closeSink(false); },
    abort() { return closeSink(true); },
  });
  try {
    await cutClip(kit, file, start, end, new kit.StreamTarget(stream, { chunked: true }));
    await closeSink(false);
  } catch (error) {
    try { await closeSink(true); } catch (ignore) { /* 文件已经关上 */ }
    try { await dir.removeEntry(name); } catch (ignore) { /* 不完整的切片删不掉也没关系 */ }
    throw error;
  }
}

async function cutToBuffer(kit, file, start, end) {
  const target = new kit.BufferTarget();
  await cutClip(kit, file, start, end, target);
  if (!target.buffer || target.buffer.byteLength < 32) throw new Error("empty");
  return new Uint8Array(target.buffer);
}

function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  files.forEach((file) => {
    const nameBytes = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, file.data.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, file.data);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, file.data.length, true);
    head.setUint32(24, file.data.length, true);
    head.setUint16(28, nameBytes.length, true);
    head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), nameBytes);
    offset += 30 + nameBytes.length + file.data.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...locals, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

function crc32(data) {
  let value = ~0;
  for (let index = 0; index < data.length; index += 1) {
    value ^= data[index];
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return ~value >>> 0;
}

function exportTable() {
  if (!project) return;
  download("切片清单.csv", "text/csv;charset=utf-8", `\uFEFF${tableCsv(project)}`);
  setStatus("切片清单已开始下载。时间码是原片里的入点和出点，顺序是切片顺序。");
}

function exportSubs() {
  if (!project) return;
  const srt = $("want-srt").checked;
  const ass = $("want-ass").checked;
  if (!srt && !ass) {
    setStatus("先勾选 SRT 或 ASS。字幕是另存，只作备忘和没写字的切片不会写进去。");
    return;
  }
  const cues = axisCues(project);
  if (!cues.length) {
    setStatus("没有可写进字幕的口播。字幕是可选项，切片清单不依赖它。");
    return;
  }
  if (srt) download("简易字幕.srt", "application/x-subrip;charset=utf-8", `\uFEFF${formatSrt(cues)}`);
  if (ass) window.setTimeout(() => download("简易字幕.ass", "text/plain;charset=utf-8", formatAss(cues)), srt ? 300 : 0);
  setStatus("字幕已按切片顺序另存，开始下载。");
}

function tableCsv(current) {
  const episodes = new Map(current.episodes.map((item, index) => [item.id, [index + 1, item]]));
  const rows = [["序号", "口播", "类型", "集序号", "文件", "入点", "出点", "时长"]];
  current.lines.forEach((line, index) => {
    const kind = line.memo ? "备忘" : (String(line.text || "").trim() ? "口播" : "切片");
    const found = episodes.get(line.episodeId);
    if (found && line.start != null && line.end != null) {
      const [episodeIndex, episode] = found;
      rows.push([index + 1, line.text || "", kind, episodeIndex, episode.name, formatClock(line.start), formatClock(line.end), formatClock(line.end - line.start)]);
    } else {
      rows.push([index + 1, line.text || "", kind, "", "", "", "", ""]);
    }
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function timeline(current) {
  if (!current) return { blocks: [], total: 0, missing: 0 };
  let cursor = 0;
  let missing = 0;
  const blocks = [];
  current.lines.forEach((line, index) => {
    if (line.start == null || line.end == null || line.end <= line.start) {
      missing += 1;
      return;
    }
    const duration = line.end - line.start;
    blocks.push({ index: index + 1, line, start: cursor, end: cursor + duration, duration });
    cursor += duration;
  });
  return { blocks, total: cursor, missing };
}

function axisCues(current) {
  return timeline(current).blocks
    .filter((block) => !block.line.memo && String(block.line.text || "").trim())
    .map((block) => [block.start, block.end, String(block.line.text).trim()]);
}

function formatSrt(cues) {
  return cues.map(([start, end, text], index) => `${index + 1}\n${formatClock(start).replace(".", ",")} --> ${formatClock(end).replace(".", ",")}\n${text}`).join("\n\n") + "\n";
}

function formatAss(cues) {
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const body = cues.map(([start, end, text]) => {
    const line = text.replace(/\r\n|\r|\n/g, "\\N").replaceAll("{", "\\{").replaceAll("}", "\\}");
    return `Dialogue: 0,${assClock(start)},${assClock(end)},Default,,0,0,0,,${line}`;
  });
  return [...head, ...body].join("\n") + "\n";
}

function assClock(seconds) {
  const millis = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(Math.floor((millis % 1000) / 10))}`;
}

function download(name, type, text) {
  downloadBlob(name, new Blob([text], { type }));
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function clipLabel(line) {
  if (!line.episodeId || !project) return "还没贴画面";
  const index = project.episodes.findIndex((episode) => episode.id === line.episodeId);
  if (index < 0) return "原片已不在这批文件里";
  return `第${pad(index + 1)}集 ${project.episodes[index].name}  ${formatClock(line.start)}–${formatClock(line.end)}`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  if (!project) return;
  const board = {
    title: project.title,
    signature: project.signature,
    episodeOrder: project.episodes.map((item) => item.id),
    lines: project.lines,
  };
  localStorage.setItem(`jianji-board:${project.signature}`, JSON.stringify(board));
  localStorage.setItem("jianji-last", project.signature);
}

function loadBoard(signature) {
  try {
    return JSON.parse(localStorage.getItem(`jianji-board:${signature}`) || "null");
  } catch {
    return null;
  }
}

function showLastHint() {
  const signature = localStorage.getItem("jianji-last");
  const board = signature ? loadBoard(signature) : null;
  if (!board) return;
  $("gate-note").textContent = `上次的「${board.title}」还留着。再选一次同一批文件，口播和切片会接上。`;
}

async function recallFolder() {
  try {
    const handle = await idbGet("dir");
    if (!handle || !handle.queryPermission) return;
    resumeHandle = handle;
    const perm = await handle.queryPermission({ mode: "read" });
    if (perm === "granted") {
      await readDirectory(handle);
      return;
    }
    $("resume").hidden = false;
    $("resume").onclick = async () => {
      const next = await handle.requestPermission({ mode: "read" });
      if (next === "granted") await readDirectory(handle);
    };
  } catch {
    resumeHandle = null;
  }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jianji", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(handle) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(handle, "dir");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(key) {
  const db = await idbOpen();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const request = tx.objectStore("kv").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

function enterFull() {
  if (!player.src) {
    setStatus("先从左边点开一集，再全屏标记。");
    return;
  }
  const node = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!node) {
    setStatus("这个浏览器不能全屏。");
    return;
  }
  node.call(stage);
}

function bindSplits() {
  const desk = $("desk");
  const saved = JSON.parse(localStorage.getItem("jianji-cols") || "{}");
  if (saved.episodes) desk.style.setProperty("--w-ep", `${saved.episodes}px`);
  if (saved.stage) desk.style.setProperty("--w-stage", `${saved.stage}px`);
  document.querySelectorAll(".split").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (window.matchMedia("(max-width: 960px)").matches) return;
      event.preventDefault();
      handle.classList.add("dragging");
      const startX = event.clientX;
      const episodeWidth = $("col-episodes").getBoundingClientRect().width;
      const stageWidth = document.querySelector(".col-stage").getBoundingClientRect().width;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (handle.dataset.split === "episodes") desk.style.setProperty("--w-ep", `${clamp(episodeWidth + dx, 180, 520)}px`);
        else desk.style.setProperty("--w-stage", `${clamp(stageWidth - dx, 280, 760)}px`);
      };
      const up = () => {
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        localStorage.setItem("jianji-cols", JSON.stringify({
          episodes: Math.round($("col-episodes").getBoundingClientRect().width),
          stage: Math.round(document.querySelector(".col-stage").getBoundingClientRect().width),
        }));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.setPointerCapture(event.pointerId);
    });
  });
}

function revokeUrls() {
  if (!project) return;
  for (const episode of project.episodes) {
    if (episode.url) URL.revokeObjectURL(episode.url);
  }
}

function directoryTitle(files) {
  const first = files && files[0];
  const relative = first && first.webkitRelativePath;
  if (!relative) return "选中的视频";
  return relative.split(/[\\/]/)[0] || "选中的视频";
}

function fileTitle(files) {
  const list = [...files].filter((file) => isVideo(file.name));
  if (list.length === 1) return stem(list[0].name);
  return "选中的视频";
}

function isVideo(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return VIDEO.has(ext);
}

function stem(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

function markSelected(list, id) {
  for (const row of list.querySelectorAll(".row")) row.classList.toggle("selected", row.dataset.id === id);
}

function move(list, id, delta) {
  const index = list.findIndex((item) => item.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(next, 0, item);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function formatClock(value) {
  const millis = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const seconds = Math.floor((millis % 60000) / 1000);
  const rest = millis % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(rest).padStart(3, "0")}`;
}

function parseClock(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function naturalCompare(a, b) {
  return a.localeCompare(b, "zh", { numeric: true, sensitivity: "base" });
}

function digest(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function uid() {
  return Math.random().toString(16).slice(2, 10);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function setStatus(text) {
  $("status").textContent = text;
}

boot();
