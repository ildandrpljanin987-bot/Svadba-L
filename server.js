const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(__dirname, 'photos.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '1010';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]');

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { files: 30, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.mimetype));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'Public')));
app.use('/uploads', express.static(UPLOAD_DIR));

function readPhotos() { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
function writePhotos(data) { fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2)); }

app.get('/api/photos', (req, res) => {
  res.json(readPhotos().sort((a,b) => b.createdAt - a.createdAt));
});

app.post('/api/upload', upload.array('photos', 30), (req, res) => {
  const photos = readPhotos();
  const added = (req.files || []).map(file => ({
    id: crypto.randomUUID(),
    file: file.filename,
    originalName: file.originalname,
    createdAt: Date.now()
  }));
  writePhotos(photos.concat(added));
  res.json({ ok: true, photos: added });
});

app.delete('/api/photos/:id', (req, res) => {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) return res.status(403).json({ ok:false, error:'Pogrešan PIN.' });
  const photos = readPhotos();
  const photo = photos.find(p => p.id === req.params.id);
  if (!photo) return res.status(404).json({ ok:false, error:'Fotografija nije pronađena.' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, photo.file)); } catch {}
  writePhotos(photos.filter(p => p.id !== req.params.id));
  res.json({ ok:true });
});

app.listen(PORT, () => console.log(`Galerija radi na http://localhost:${PORT}`));
