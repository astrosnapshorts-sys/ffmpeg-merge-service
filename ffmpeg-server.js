/**
 * 🎞️ FFmpeg Video Merge Microservice
 * Render.com Free Tier'a Deploy Edilecek
 * 
 * Kurulum: Node.js + FFmpeg
 * Port: 3000 (Render otomatik ayarlar)
 */
const ffmpegStatic = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegStatic);
const express = require('express');
const { execSync, exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FFMPEG_API_KEY || 'change-this-secret-key';
const WORK_DIR = '/tmp/ffmpeg_work';

// ─── Auth Middleware ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg Merge Service', time: new Date().toISOString() });
});

// ─── Video Download Helper ───────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ─── Main Merge Endpoint ─────────────────────────────────────────────────────
app.post('/merge', async (req, res) => {
  const { clips, run_id, output_format = 'mp4' } = req.body;

  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array is required' });
  }

  const jobDir = path.join(WORK_DIR, run_id || `job_${Date.now()}`);
  
  try {
    // Çalışma dizini oluştur
    fs.mkdirSync(jobDir, { recursive: true });
    console.log(`📁 Job başlatıldı: ${jobDir}`);
    console.log(`🎬 ${clips.length} klip birleştirilecek`);

    // Tüm klipleri paralel indir
    console.log('⬇️  Klipler indiriliyor...');
    const downloadPromises = clips.map(async (url, i) => {
      const dest = path.join(jobDir, `clip_${String(i).padStart(3, '0')}.mp4`);
      await downloadFile(url, dest);
      console.log(`  ✓ Klip ${i + 1}/${clips.length} indirildi`);
      return dest;
    });
    
    const clipPaths = await Promise.all(downloadPromises);

    // FFmpeg concat listesi oluştur
    const concatFile = path.join(jobDir, 'concat_list.txt');
    const concatContent = clipPaths
      .sort() // scene_number sırasına göre (clip_001, clip_002...)
      .map(p => `file '${p}'`)
      .join('\n');
    fs.writeFileSync(concatFile, concatContent);

    // FFmpeg ile birleştir
    const outputFile = path.join(jobDir, `merged_output.${output_format}`);
    console.log('🎞️  FFmpeg birleştirme başlıyor...');
    
    const ffmpegCmd = [
      'ffmpeg',
      '-f concat',
      '-safe 0',
      `-i "${concatFile}"`,
      '-c:v libx264',
      '-c:a aac',
      '-preset fast',
      '-crf 23',
      '-movflags +faststart', // YouTube için optimize
      '-y',
      `"${outputFile}"`
    ].join(' ');

    await execAsync(ffmpegCmd, { timeout: 300000 }); // 5 dk timeout
    console.log('✅ FFmpeg birleştirme tamamlandı');

    // Dosya boyutunu kontrol et
    const stats = fs.statSync(outputFile);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📦 Çıktı dosyası: ${fileSizeMB} MB`);

    // Video'yu stream et (n8n indirebilsin)
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="cartoon_${run_id}.mp4"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('X-File-Size-MB', fileSizeMB);
    
    const readStream = fs.createReadStream(outputFile);
    readStream.pipe(res);

    readStream.on('end', () => {
      // Temizlik (async, response'dan sonra)
      setTimeout(() => {
        try {
          fs.rmSync(jobDir, { recursive: true, force: true });
          console.log('🧹 Temp dosyalar temizlendi');
        } catch (e) {
          console.error('Temizlik hatası:', e);
        }
      }, 5000);
    });

  } catch (error) {
    console.error('❌ Merge hatası:', error.message);
    
    // Temizlik
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e) {}
    
    res.status(500).json({
      error: 'Video merge failed',
      details: error.message
    });
  }
});

// ─── Status Endpoint ─────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  try {
    const ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1').toString().trim();
    const diskInfo = execSync('df -h /tmp | tail -1').toString().trim();
    res.json({
      status: 'running',
      ffmpeg: ffmpegVersion,
      disk: diskInfo,
      work_dir_exists: fs.existsSync(WORK_DIR)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Server Start ─────────────────────────────────────────────────────────────
fs.mkdirSync(WORK_DIR, { recursive: true });
app.listen(PORT, () => {
  console.log(`🚀 FFmpeg Merge Service çalışıyor: http://0.0.0.0:${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  try {
    const v = execSync('ffmpeg -version 2>&1 | head -1').toString().trim();
    console.log(`✅ FFmpeg: ${v}`);
  } catch(e) {
    console.error('❌ FFmpeg bulunamadı! Render build komutuna "apt-get install -y ffmpeg" ekleyin.');
  }
});
