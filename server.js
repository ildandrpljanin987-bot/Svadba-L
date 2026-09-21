const express = require("express");
const multer = require("multer");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const archiver = require("archiver");
const path = require("path");
const fs = require("fs");
const { PassThrough, Transform } = require("stream");

const app = express();

const PORT = process.env.PORT || 3000;

const BUCKET = process.env.BUCKET;
const REGION = process.env.REGION;
const ENDPOINT = process.env.ENDPOINT;
const ACCESS_KEY_ID = process.env.ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY;

const ADMIN_PIN = process.env.ADMIN_PIN || "1010";

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "Public")));

const IMAGE_LIMIT = 50 * 1024 * 1024;
const VIDEO_LIMIT = 500 * 1024 * 1024;

const allowedImages = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
];

const allowedVideos = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v"
];

function getFileLimit(mimetype) {
  if (allowedVideos.includes(mimetype)) {
    return VIDEO_LIMIT;
  }

  if (allowedImages.includes(mimetype)) {
    return IMAGE_LIMIT;
  }

  return 0;
}

function createLimitedStream(file, limit) {
  let total = 0;

  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;

      if (total > limit) {
        const error = new multer.MulterError("LIMIT_FILE_SIZE");
        error.limit = limit;
        callback(error);
        return;
      }

      callback(null, chunk);
    }
  });

  file.stream.on("error", (err) => {
    limiter.destroy(err);
  });

  return limiter;
}

const storage = {
  _handleFile(req, file, cb) {
    const limit = getFileLimit(file.mimetype);

    if (!limit) {
      return cb(new Error("Nepodržan format fajla."));
    }

    const safeName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    const key =
      "photos/" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 8) +
      "-" +
      safeName;

    const pass = new PassThrough();
const limited = createLimitedStream(file, limit);

file.stream.pipe(limited).pipe(pass);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: pass,
        ContentType: file.mimetype
      }
    });

    let finished = false;

    function finish(err, result) {
      if (finished) return;
      finished = true;

      if (err) {
        return cb(err);
      }

      cb(null, {
        key,
        size: result?.ContentLength || 0
      });
    }

    limited.on("error", (err) => {
      pass.destroy(err);
      finish(err);
    });

    upload.done()
      .then((result) => {
        finish(null, result);
      })
      .catch((err) => {
        finish(err);
      });
  },

  _removeFile(req, file, cb) {
    if (!file.key) {
      return cb();
    }

    s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: file.key
      })
    )
      .then(() => cb())
      .catch(cb);
  }
};

const upload = multer({
  storage,

  limits: {
    files: 150
  },

  fileFilter: (req, file, cb) => {
    const isImage = allowedImages.includes(file.mimetype);
    const isVideo = allowedVideos.includes(file.mimetype);

    if (isImage || isVideo) {
      cb(null, true);
    } else {
      cb(new Error("Dozvoljene su fotografije i video fajlovi."));
    }
  }
});


/* =========================
   LISTA FOTOGRAFIJA I VIDEA
========================= */

app.get("/api/photos", async (req, res) => {
  try {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "photos/"
      })
    );

    const files = (result.Contents || [])
      .filter((item) => item.Key && item.Key !== "photos/")
      .map((item) => ({
        key: item.Key,
        url: `/uploads/${item.Key}`,
        name: path.basename(item.Key)
      }));

    res.json(files);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Greška pri učitavanju galerije."
    });
  }
});


/* =========================
   UPLOAD
========================= */

app.post("/api/upload", upload.array("photos", 150), (req, res) => {
  res.json({
    success: true,
    uploaded: req.files ? req.files.length : 0
  });
});


/* =========================
   PRIKAZ FAJLA
========================= */

app.get("/uploads/:folder/:filename", async (req, res) => {
  try {
    const key =
      req.params.folder + "/" + req.params.filename;

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key
      })
    );

    if (result.ContentType) {
      res.setHeader("Content-Type", result.ContentType);
    }

    result.Body.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(404).send("Fajl nije pronađen.");
  }
});


/* =========================
   PREUZIMANJE JEDNOG FAJLA
========================= */

app.get("/api/download", async (req, res) => {
  try {
    const pin = req.headers["x-admin-pin"];

    if (pin !== ADMIN_PIN) {
      return res.status(403).json({
        error: "Pogrešan PIN."
      });
    }

    const key = req.query.key;

    if (!key) {
      return res.status(400).json({
        error: "Nedostaje fajl."
      });
    }

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key
      })
    );

    const filename = path.basename(key);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    if (result.ContentType) {
      res.setHeader("Content-Type", result.ContentType);
    }

    result.Body.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Greška pri preuzimanju."
    });
  }
});


/* =========================
   PREUZMI SVE
========================= */

app.get("/api/download-all", async (req, res) => {
  try {
    const pin = req.headers["x-admin-pin"];

    if (pin !== ADMIN_PIN) {
      return res.status(403).json({
        error: "Pogrešan PIN."
      });
    }

    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "photos/"
      })
    );

    const files = (result.Contents || [])
      .filter((item) => item.Key && item.Key !== "photos/");

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="lamija-nedim-fotografije-i-videi.zip"'
    );

    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", {
      zlib: { level: 0 }
    });

    archive.on("error", (err) => {
      console.error(err);

      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    for (const file of files) {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: file.Key
        })
      );

      archive.append(object.Body, {
        name: path.basename(file.Key)
      });
    }

    await archive.finalize();

  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Greška pri pravljenju ZIP-a."
      });
    }
  }
});


/* =========================
   GREŠKE
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error:
          "Fajl je prevelik. Fotografije mogu imati do 50 MB, a videi do 500 MB."
      });
    }

    return res.status(400).json({
      error: err.message
    });
  }

  res.status(400).json({
    error: err.message || "Greška."
  });
});


/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`Server radi na portu ${PORT}`);
});
