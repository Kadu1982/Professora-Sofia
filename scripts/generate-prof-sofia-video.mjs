import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const ffmpeg = ffmpegInstaller.path;
const img = join(root, 'public', 'images', 'professora-sofia.png');
const outDir = join(root, 'public', 'images');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

const base = [
  '-loop',
  '1',
  '-i',
  img,
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
];

console.log('Gerando vídeos da Professora Sofia...');

await run([
  ...base,
  '-vf',
  "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0008,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1280x720:fps=30",
  '-t',
  '5',
  '-c:v',
  'libx264',
  '-y',
  join(outDir, 'professora-sofia-idle.mp4'),
]);

await run([
  ...base,
  '-vf',
  "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0025,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1280x720:fps=30",
  '-t',
  '3',
  '-c:v',
  'libx264',
  '-y',
  join(outDir, 'professora-sofia-fala.mp4'),
]);

console.log('OK: professora-sofia-idle.mp4 e professora-sofia-fala.mp4');
