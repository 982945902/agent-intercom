# Third-party notices

Agent Intercom's own code has no selected open-source license (`UNLICENSED`). That does not change the separate licenses of its dependencies. Dependencies are installed by npm from the pinned lockfile; their source is not vendored in this repository. Keep their upstream notices when redistributing dependency code.

## Direct dependencies

The lockfile records the exact package versions. Direct runtime dependencies ship under the following licenses.

| Package | License | Copyright notice |
| --- | --- | --- |
| `react` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-dom` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `zod` | MIT | Copyright (c) 2025 Colin McDonnell |

The Dashboard’s Antigravity and Codex vectors come from `@lobehub/icons-static-svg` 1.106.0 (MIT, LobeHub). The OMP glyph is based on the icon at `omp.sh`, and the Alma icon comes from the Alma application. The marks identify their respective hosts.

TypeScript is a build dependency under Apache-2.0. Vite and the direct `@types/*` packages are build dependencies under MIT. Their installed license files contain the applicable terms and notices.

### MIT license terms

The following terms apply separately to the MIT-licensed dependencies and artwork above, with their respective copyright notices.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Transitive dependencies and host applications

This is not an exhaustive inventory of transitive dependencies. `package-lock.json` identifies the resolved dependency graph; each installed package's own license and notices govern it. Review those files when distributing an installation, rather than assuming every transitive dependency uses MIT.

OMP and Antigravity are separately installed host applications. Names identify interoperability targets and do not imply sponsorship, endorsement, or an official compatibility commitment.
