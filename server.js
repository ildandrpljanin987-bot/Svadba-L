const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

const BUCKET = process.env.BUCKET;
const REGION = process.env.REGION || 'auto';
const ENDPOINT = process.env.ENDPOINT;
const ACCESS_KEY_ID = process.env.ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY;

const ADMIN_PIN = process.env.ADMIN_PIN || '1010';

if (!BUCKET || !ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error('Nedostaju Railway Bucket varijable.');
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: false,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY
  }
});

const storage = multer.memoryStorage();

const upload = multer({
  storage,

  limits: {
    files: 150,
    fileSize: 50 * 1024 * 1024
  },

  fileFilter: (_, file, cb) => {
    const allowed = /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(
      file.mimetype
    );

    cb(null, allowed);
  }
});

app.use(express.json());

app.use(express.static(__dirname + '/Public'));

/*
  Čitanje fotografije iz privatnog Railway Bucketa
*/
app.get('/uploads/*', async (req, res) => {
  const key = req.params[0];

  if (!key || !key.startsWith('photos/')) {
    return res.status(404).end();
  }

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key
      })
    );

    if (result.ContentType) {
      res.setHeader('Content-Type', result.ContentType);
    }

    if (result.ContentLength) {
      res.setHeader('Content-Length', result.ContentLength);
    }

    res.setHeader(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    );

    result.Body.pipe(res);

  } catch (error) {
    console.error('Greška pri čitanju fotografije:', error);
    res.status(404).end();
  }
});


/*
  Učitavanje svih fotografija iz Bucketa
*/
async function listPhotos() {
  const photos = [];
  let continuationToken;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'photos/',
        ContinuationToken: continuationToken
      })
    );

    for (const object of result.Contents || []) {
      if (!object.Key || object.Key.endsWith('/')) continue;

      const encodedId = Buffer
        .from(object.Key, 'utf8')
        .toString('base64url');

      photos.push({
        id: encodedId,
        file: object.Key,
        originalName: object.Key,
        createdAt: object.LastModified
          ? new Date(object.LastModified).getTime()
          : 0
      });
    }

    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;

  } while (continuationToken);

  return photos.sort(
    (a, b) => b.createdAt - a.createdAt
  );
}


/*
  API - galerija
*/
app.get('/api/photos', async (req, res) => {
  try {
    const photos = await listPhotos();

    res.json(photos);

  } catch (error) {
    console.error(
      'Greška pri učitavanju galerije:',
      error
    );

    res.status(500).json({
      ok: false,
      error: 'Galerija trenutno nije dostupna.'
    });
  }
});


/*
  API - upload fotografija

  Maksimalno:
  150 fotografija
  50 MB po fotografiji
*/
app.post(
  '/api/upload',
  upload.array('photos', 150),
  async (req, res) => {

    try {
      const files = req.files || [];

      const added = [];

      for (const file of files) {

        const extension =
          getExtension(
            file.originalname,
            file.mimetype
          );

        const key =
          `photos/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
            CacheControl:
              'public, max-age=31536000, immutable'
          })
        );

        const id =
          Buffer
            .from(key, 'utf8')
            .toString('base64url');

        added.push({
          id,
          file: key,
          originalName: file.originalname,
          createdAt: Date.now()
        });
      }

      res.json({
        ok: true,
        photos: added
      });

    } catch (error) {

      console.error(
        'Greška pri uploadu:',
        error
      );

      res.status(500).json({
        ok: false,
        error: 'Upload nije uspio.'
      });
    }
  }
);


/*
  Brisanje fotografije
*/
app.delete(
  '/api/photos/:id',
  async (req, res) => {

    if (
      req.headers['x-admin-pin'] !==
      ADMIN_PIN
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Pogrešan PIN.'
      });
    }

    try {

      const key =
        Buffer
          .from(
            req.params.id,
            'base64url'
          )
          .toString('utf8');

      if (!key.startsWith('photos/')) {
        return res.status(400).json({
          ok: false,
          error: 'Neispravan ID.'
        });
      }

      await s3.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: key
        })
      );

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(
        'Greška pri brisanju:',
        error
      );

      res.status(500).json({
        ok: false,
        error: 'Brisanje nije uspjelo.'
      });
    }
  }
);


/*
  Greške Multer-a
*/
app.use(
  (error, req, res, next) => {

    if (error instanceof multer.MulterError) {

      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          ok: false,
          error:
            'Jedna fotografija je veća od 50 MB.'
        });
      }

      if (error.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          ok: false,
          error:
            'Možete poslati najviše 150 fotografija odjednom.'
        });
      }

      return res.status(400).json({
        ok: false,
        error: 'Upload nije dozvoljen.'
      });
    }

    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Došlo je do greške.'
    });
  }
);


function getExtension(
  originalName,
  mimeType
) {

  const match =
    String(originalName || '')
      .toLowerCase()
      .match(/\.[a-z0-9]+$/);

  if (match) {
    return match[0];
  }

  const extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif'
  };

  return extensions[mimeType] || '.jpg';
}


app.listen(
  PORT,
  () => {
    console.log(
      `Galerija radi na http://localhost:${PORT}`
    );
  }
);
