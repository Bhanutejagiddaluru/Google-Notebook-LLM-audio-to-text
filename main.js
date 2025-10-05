const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

let win;

function create() {
  win = new BrowserWindow({
    width: 920,
    height: 560,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    show: false
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());

function sendStatus(text) {
  if (win && !win.isDestroyed()) win.webContents.send('status', text);
}

/* ---------------- UI pickers ---------------- */
ipcMain.handle('ui:pick-audio', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select audio file',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['wav','mp3','m4a','aac','flac','ogg','wma','webm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths?.length) return null;
  return { path: r.filePaths[0] };
});
ipcMain.handle('ui:pick-binary', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select Whisper CLI binary (e.g., whisper-cli.exe)',
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths?.length) return null;
  return { path: r.filePaths[0] };
});
ipcMain.handle('ui:pick-model', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select model file (e.g., ggml-base.en.bin)',
    properties: ['openFile'],
    filters: [{ name: 'Model', extensions: ['bin','gguf'] }, { name: 'All Files', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths?.length) return null;
  return { path: r.filePaths[0] };
});

/* ---------------- Core job ---------------- */
ipcMain.handle('job:transcribe', async (_evt, payload) => {
  try {
    const { audioPath, whisperBin, modelPath, language, noTimestamps } = payload || {};
    if (!audioPath || !fs.existsSync(audioPath)) {
      return { ok: false, error: 'Audio path is empty or not found.' };
    }

    const dir = path.dirname(audioPath);
    const base = path.basename(audioPath, path.extname(audioPath));
    const desiredTxt = path.join(dir, `${base}.txt`);

    // 1) If not WAV, convert to 16k mono WAV with ffmpeg (needs ffmpeg.exe in PATH)
    const isWav = path.extname(audioPath).toLowerCase() === '.wav';
    const wavForWhisper = isWav ? audioPath : path.join(dir, `${base}__whisper_tmp.wav`);

    if (!isWav) {
      sendStatus('Converting to WAV (ffmpeg)…');
      await convertToWav(audioPath, wavForWhisper); // throws if ffmpeg missing/fails
    }

    // 2) Build Whisper args (robust variants)
    const bin = (whisperBin && fs.existsSync(whisperBin))
      ? whisperBin
      : (process.platform === 'win32' ? 'whisper-cli' : 'whisper');

    const common = [];
    if (language) common.push('-l', language);
    if (noTimestamps) common.push('--no-timestamps');
    if (modelPath && fs.existsSync(modelPath)) common.push('-m', modelPath);

    const variants = [
      ['-f', wavForWhisper, '-otxt', '-of', desiredTxt, ...common],
      ['-f', wavForWhisper, '-otxt', '--output-file', desiredTxt, ...common],
      ['-f', wavForWhisper, '-otxt', '-o', dir, ...common],
      ['-f', wavForWhisper, '-otxt', ...common],
    ];

    // Pre-scan to detect newly created .txt files later
    const preExisting = new Set(listTxt(dir));
    let lastStdout = '', lastStderr = '';

    for (let i = 0; i < variants.length; i++) {
      sendStatus(`Running Whisper (attempt ${i + 1}/${variants.length})…`);
      const { stdout, stderr } = await execFileSafe(bin, variants[i]);
      lastStdout = stdout; lastStderr = stderr;

      if (fs.existsSync(desiredTxt) && fileNonEmpty(desiredTxt)) {
        cleanupTemp(wavForWhisper, isWav);
        sendStatus('Done.');
        return { ok: true, outputPath: desiredTxt };
      }
      const after = listTxt(dir).filter(p => !preExisting.has(p));
      const newest = newestByMtime(after);
      if (newest && fileNonEmpty(newest)) {
        const text = fs.readFileSync(newest, 'utf8');
        fs.writeFileSync(desiredTxt, text, 'utf8');
        if (normalize(newest) !== normalize(desiredTxt)) safeUnlink(newest);
        cleanupTemp(wavForWhisper, isWav);
        sendStatus('Done.');
        return { ok: true, outputPath: desiredTxt };
      }
    }

    // Fallback: save stdout
    if (lastStdout && lastStdout.trim().length > 0) {
      fs.writeFileSync(desiredTxt, lastStdout, 'utf8');
      cleanupTemp(wavForWhisper, isWav);
      sendStatus('Done (saved from stdout).');
      return { ok: true, outputPath: desiredTxt, note: 'Saved from stdout fallback.' };
    }

    // Failure: write diagnostic log
    const diagnostic = desiredTxt.replace(/\.txt$/i, '.log.txt');
    fs.writeFileSync(diagnostic, [
      '--- STDOUT ---\n', lastStdout || '(empty)', '\n\n',
      '--- STDERR ---\n', lastStderr || '(empty)', '\n'
    ].join(''), 'utf8');
    cleanupTemp(wavForWhisper, isWav);
    return { ok: false, error: `Transcription finished but no .txt file was found. Saved logs to ${diagnostic}` };

  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/* ---------------- helpers ---------------- */
function convertToWav(inputPath, outWavPath) {
  return new Promise((resolve, reject) => {
    // ffmpeg -y -i "<in>" -ar 16000 -ac 1 -f wav "<out>"
    const ff = spawn(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outWavPath],
      { windowsHide: true }
    );
    let errBuf = '';
    ff.stderr.on('data', d => { errBuf += d.toString(); sendStatus(String(d)); });
    ff.on('error', (e) => reject(new Error(`ffmpeg not found. Please install ffmpeg and make sure it's on PATH. (${e.message})`)));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outWavPath) && fileNonEmpty(outWavPath)) resolve();
      else reject(new Error(`ffmpeg failed (code ${code}). ${errBuf.split('\n').slice(-10).join('\n')}`));
    });
  });
}

function execFileSafe(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 10 * 60 * 1000, ...options }, (_error, stdout, stderr) => {
      // Some builds exit non-zero even when they write files, so never reject here.
      resolve({ stdout: stdout?.toString?.() || '', stderr: stderr?.toString?.() || '' });
    });
    child.stdout?.on('data', d => sendStatus(String(d)));
    child.stderr?.on('data', d => sendStatus(String(d)));
  });
}

function listTxt(dir) {
  try { return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt')).map(f => path.join(dir, f)); }
  catch { return []; }
}
function newestByMtime(paths) {
  let best = null, bestT = -1;
  for (const p of paths) {
    try { const t = fs.statSync(p).mtimeMs; if (t > bestT) { bestT = t; best = p; } } catch {}
  }
  return best;
}
function fileNonEmpty(p) { try { return fs.statSync(p).size > 0; } catch { return false; } }
function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
function normalize(p) { return path.normalize(p).toLowerCase(); }
function cleanupTemp(wavPath, wasWavInput) { if (!wasWavInput) safeUnlink(wavPath); }
