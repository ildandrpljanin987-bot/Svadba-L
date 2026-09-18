const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { PassThrough } = require('stream');
const archiver = require('archiver');

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const { Upload } = require('@aws-sdk/lib-storage');

const app = express();
const PORT = process.env.PORT || 3000;

const BUCKET = process.env.BUCKET;
const REGION = process.env.REGION || 'us-west-1';
const ENDPOINT = process.env.ENDPOINT;
const ACCESS_KEY_ID = process.env.ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY;

const ADMIN_PIN = process.env.ADMIN_PIN || '1010';

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});


// ===============================
// UPLOAD STORAGE
// ===============================

const storage = {

  _handleFile(req, file, cb) {

    const ext =
      path.extname(file.originalname).toLowerCase() || '.jpg';

    const key =
      `photos/${Date.now()}-${crypto
        .randomBytes(6)
        .toString('hex')}${ext}`;

    const pass = new PassThrough();

    const upload = new Upload({
      client: s3,

      params: {
        Bucket: BUCKET,
        Key: key,
        Body: pass,
        ContentType:
          file.mimetype || 'application/octet-stream'
      }
    });

    file.stream.pipe(pass);

    upload.done()
      .then(() => {

        cb(null, {
          key: key
        });

      })
      .catch(err => {

        console.error(err);
        cb(err);

      });

  },

  _removeFile(req, file, cb) {

    if (!file.key) {
      return cb(null);
    }

    s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: file.key
      })
    )
      .then(() => cb(null))
      .catch(cb);

  }

};


// ===============================
// MULTER
// ===============================

const upload = multer({

  storage: storage,

  limits: {

    files: 150,

    fileSize:
      50 * 1024 * 1024

  },

  fileFilter: (req, file, cb) => {

    const allowed =
      /^image\/(jpeg|png|webp|gif|heic|heif)$/i
        .test(file.mimetype);

    cb(null, allowed);

  }

});


app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, 'Public')
  )
);


// ===============================
// PIN PROVJERA
// ===============================

function checkPin(req, res) {

  if (
    req.headers['x-admin-pin'] !== ADMIN_PIN
  ) {

    res.status(403).json({

      ok: false,

      error: 'Pogrešan PIN.'

    });

    return false;

  }

  return true;

}


// ===============================
// LISTA SVIH FOTOGRAFIJA
// ===============================

async function listAllPhotos() {

  const photos = [];

  let token;

  do {

    const result =
      await s3.send(

        new ListObjectsV2Command({

          Bucket: BUCKET,

          Prefix: 'photos/',

          ContinuationToken: token

        })

      );


    for (
      const obj of
      result.Contents || []
    ) {

      if (
        !obj.Key ||
        obj.Key.endsWith('/')
      ) {

        continue;

      }


      photos.push({

        id: obj.Key,

        file: obj.Key,

        originalName:
          obj.Key.split('/').pop(),

        size:
          obj.Size || 0,

        createdAt:
          obj.LastModified
            ? new Date(
                obj.LastModified
              ).getTime()
            : 0

      });

    }


    token =
      result.IsTruncated
        ? result.NextContinuationToken
        : undefined;

  }

  while (token);


  return photos.sort(
    (a, b) =>
      b.createdAt - a.createdAt
  );

}


// ===============================
// GALERIJA
// ===============================

app.get(
  '/api/photos',
  async (req, res) => {

    try {

      const photos =
        await listAllPhotos();

      res.json(photos);

    }

    catch (error) {

      console.error(error);

      res.status(500).json({

        ok: false,

        error:
          'Galerija trenutno nije dostupna.'

      });

    }

  }
);


// ===============================
// UPLOAD FOTOGRAFIJA
// ===============================

app.post(
  '/api/upload',
  (req, res) => {

    upload.array(
      'photos',
      150
    )(req, res, async error => {

      if (error) {

        console.error(error);


        if (
          error.code ===
          'LIMIT_FILE_SIZE'
        ) {

          return res
            .status(400)
            .json({

              ok: false,

              error:
                'Jedna fotografija je veća od 50 MB.'

            });

        }


        if (
          error.code ===
          'LIMIT_FILE_COUNT'
        ) {

          return res
            .status(400)
            .json({

              ok: false,

              error:
                'Možete objaviti najviše 150 fotografija odjednom.'

            });

        }


        return res
          .status(400)
          .json({

            ok: false,

            error:
              'Fotografije nisu uspješno objavljene.'

          });

      }


      const photos =
        (req.files || [])
          .map(file => ({

            id: file.key,

            file: file.key,

            originalName:
              file.originalname,

            createdAt:
              Date.now()

          }));


      res.json({

        ok: true,

        photos: photos

      });

    });

  }
);


// ===============================
// PRIKAZ FOTOGRAFIJE
// ===============================

app.get(
  '/uploads/:folder/:filename',
  async (req, res) => {

    if (
      req.params.folder !==
      'photos'
    ) {

      return res
        .status(404)
        .end();

    }


    const key =
      `photos/${req.params.filename}`;


    try {

      const result =
        await s3.send(

          new GetObjectCommand({

            Bucket: BUCKET,

            Key: key

          })

        );


      if (result.ContentType) {

        res.setHeader(
          'Content-Type',
          result.ContentType
        );

      }


      res.setHeader(
        'Cache-Control',
        'public, max-age=31536000'
      );


      result.Body.pipe(res);

    }

    catch (error) {

      console.error(error);

      res
        .status(404)
        .end();

    }

  }
);


// ===============================
// PREUZMI JEDNU FOTOGRAFIJU
// ===============================

app.get(
  '/api/download',
  async (req, res) => {

    if (!checkPin(req, res)) {
      return;
    }


    const key =
      String(req.query.key || '');


    if (
      !key.startsWith('photos/') ||
      key.includes('..')
    ) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            'Neispravna fotografija.'

        });

    }


    try {

      const result =
        await s3.send(

          new GetObjectCommand({

            Bucket: BUCKET,

            Key: key

          })

        );


      const filename =
        key.split('/').pop() ||
        'fotografija.jpg';


      res.setHeader(
        'Content-Type',
        result.ContentType ||
          'application/octet-stream'
      );


      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename
          .replace(
            /[^a-zA-Z0-9._-]/g,
            '_'
          )}"`
      );


      result.Body.pipe(res);

    }

    catch (error) {

      console.error(error);

      res
        .status(404)
        .json({

          ok: false,

          error:
            'Fotografija nije pronađena.'

        });

    }

  }
);


// ===============================
// PREUZMI SVE - ZIP
// ===============================

app.get(
  '/api/download-all',
  async (req, res) => {

    if (!checkPin(req, res)) {
      return;
    }


    try {

      const photos =
        await listAllPhotos();


      if (!photos.length) {

        return res
          .status(404)
          .json({

            ok: false,

            error:
              'Nema fotografija za preuzimanje.'

          });

      }


      res.setHeader(
        'Content-Type',
        'application/zip'
      );


      res.setHeader(
        'Content-Disposition',
        'attachment; filename="lamija-nedim-fotografije.zip"'
      );


      const archive =
        archiver(
          'zip',
          {
            zlib: {
              level: 0
            }
          }
        );


      archive.on(
        'error',
        error => {

          console.error(
            'ZIP error:',
            error
          );

          res.destroy(error);

        }
      );


      archive.pipe(res);


      const usedNames =
        new Map();


      for (
        const photo of photos
      ) {

        const result =
          await s3.send(

            new GetObjectCommand({

              Bucket: BUCKET,

              Key: photo.file

            })

          );


        let filename =
          photo.originalName ||
          photo.file.split('/').pop() ||
          'fotografija.jpg';


        filename =
          filename.replace(
            /[\/\\:*?"<>|]/g,
            '_'
          );


        const match =
          filename.match(
            /(\.[^.]+)$/
          );


        const ext =
          match ? match[1] : '';


        const base =
          filename.replace(
            /(\.[^.]+)$/,
            ''
          );


        const number =
          (usedNames.get(filename) || 0)
          + 1;


        usedNames.set(
          filename,
          number
        );


        if (number > 1) {

          filename =
            `${base}-${number}${ext}`;

        }


        archive.append(
          result.Body,
          {
            name: filename
          }
        );


        await new Promise(
          (resolve, reject) => {

            result.Body.once(
              'end',
              resolve
            );

            result.Body.once(
              'error',
              reject
            );

          }
        );

      }


      await archive.finalize();

    }

    catch (error) {

      console.error(
        'Download-all error:',
        error
      );


      if (!res.headersSent) {

        res
          .status(500)
          .json({

            ok: false,

            error:
              'ZIP nije moguće napraviti.'

          });

      }

      else {

        res.destroy(error);

      }

    }

  }
);


// ===============================
// POKRETANJE SERVERA
// ===============================

app.listen(
  PORT,
  () => {

    console.log(
      `Galerija radi na http://localhost:${PORT}`
    );

  }
);
