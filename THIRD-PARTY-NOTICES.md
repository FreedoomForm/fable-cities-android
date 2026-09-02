# Third-party notices

This project bundles the following libraries. Their licences are reproduced here because
minification strips the notices from the built output in `dist/`.

## three.js

Copyright © 2010-2026 three.js authors — https://github.com/mrdoob/three.js

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Draco decoder

The glTF loader is configured to fetch the Draco decoder from Google's CDN at runtime
(`https://www.gstatic.com/draco/versioned/decoders/`). It is not bundled. Draco is licensed
under Apache-2.0 — https://github.com/google/draco

## Assets

All bundled textures, HDRIs and models are CC0 (public domain). Sources are listed in
`public/assets/CREDITS.md`. Kenney's vehicle models ship their own licence at
`public/assets/simulation/models/KENNEY_LICENSE.txt`.
