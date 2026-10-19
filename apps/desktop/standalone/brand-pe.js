#!/usr/bin/env node
/* Add the VoxBridge icon and version information to a Windows executable.
 *
 * Usage: node brand-pe.js <input.exe> <icon.ico> "<File description>" <output.exe>
 *
 * Requires resedit and pe-library (both MIT):
 *   npm install --no-save resedit pe-library
 */

const fs = require('fs');
const path = require('path');
const PELib = require('pe-library');
const ResEdit = require('resedit');

const [input, iconPath, description, output] = process.argv.slice(2);
if (!input || !iconPath || !output) {
  console.error('usage: brand-pe.js <input.exe> <icon.ico> "<description>" <output.exe>');
  process.exit(2);
}

const executable = PELib.NtExecutable.from(fs.readFileSync(input), { ignoreCert: true });
const resources = PELib.NtExecutableResource.from(executable);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));

ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  1,
  1033,
  iconFile.icons.map((icon) => icon.data),
);

const version = ResEdit.Resource.VersionInfo.createEmpty();
version.setFileVersion(1, 0, 0, 0);
version.setProductVersion(1, 0, 0, 0);
version.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    FileDescription: description || 'VoxBridge',
    ProductName: 'VoxBridge',
    CompanyName: 'VoxBridge',
    LegalCopyright: 'MIT License',
    OriginalFilename: path.basename(output),
    FileVersion: '1.0.0',
    ProductVersion: '1.0.0',
  },
);
version.outputToResourceEntries(resources.entries);
resources.outputResource(executable);

fs.writeFileSync(output, Buffer.from(executable.generate()));
console.log(`branded ${output}`);
