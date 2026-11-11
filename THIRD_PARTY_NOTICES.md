# Third-party notices

Agent Intercom's own code has no selected open-source license (`UNLICENSED`). That does not change the separate licenses of its dependencies. Dependencies are installed by npm from the pinned lockfile; their source is not vendored in this repository. Keep their upstream notices when redistributing dependency code.

## Direct dependencies

The following versions and attributions were checked against their installed package metadata and license files:

| Package | Version | License | Copyright notice |
| --- | --- | --- | --- |
| `pi-intercom` | 0.18.1 | MIT | Copyright (c) 2026 Nico Bailon |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | 1.32.2 | MIT | Copyright (c) 2024 Anthropic, PBC |
| [`ws`](https://github.com/websockets/ws) | 8.22.2 | MIT | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors |

The email above is part of the upstream public copyright notice, not a project maintainer contact.

### MIT license terms

The following terms apply separately to each of the above dependencies, with its respective copyright notice:

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

OMP, Codex and Alma are separately installed host applications, not bundled here. No Alma application source is shipped. Names identify interoperability targets and do not imply sponsorship, endorsement, or an official compatibility commitment.
