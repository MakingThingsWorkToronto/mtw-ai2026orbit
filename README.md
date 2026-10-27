# AI orbit model

An independent Making Things Work experiment: https://ai2026orbit.makingthings.work/.

## Run

Node 24 or later, with no npm dependencies:

```sh
npm test
npm run dev
npm run build
```

The player runs on http://127.0.0.1:8795/. Vercel serves the static `dist/` folder. Run `npm run studio` for local asset inspection on port 8796.

The original HTML, scripts, models and bundled licences are included. Geometry is retained as the supplied JSON and binary export; the JavaScript scene sources are editable.

[All experiments](https://www.makingthings.work/experiments/).

## Re-export geometry

The exact selected source is `assets/blender/enterprise/enterprise-orbits-v12c.blend`; the browser export is v12d. Install Blender 5.2 or later (its bundled Python includes NumPy), then choose a fresh output version:

```sh
blender --background --threads 3 --python tools/blender/export-orbits-v12.py -- --source ../../assets/blender/enterprise/enterprise-orbits-v12c.blend --version v13 --output-dir assets/models
```

Update the model URL in `assets/enterprise-orbits-v12/holograms.js` only after inspecting the new export. The exporter refuses existing output versions. `tools/blender/build-enterprise-orbits-v12.py` and its native module libraries are included for authoring new compositions.

Before rebuilding a composition, run `npm run prepare:native`. One large native module is stored as lossless `.blend.gz` to fit GitHub’s file-size limit; the command restores and checks its exact original bytes. Playback and the website build use the included browser export.
The lossless archive is split into three numbered parts under 60 MB each. `prepare:native` joins them automatically; Git LFS is not required.
