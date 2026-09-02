// Packs PNGs into a Windows .ico, because macOS ships no tool that writes one
// and the icon is needed on a Windows Start Menu shortcut. The container is a
// header, one 16-byte directory entry per size, and the PNG bytes themselves —
// Windows has read PNG-compressed entries since Vista.
//
//   node scripts/make-ico.js out.ico 16.png 32.png …

const { readFileSync, writeFileSync } = require('node:fs')

const [output, ...sources] = process.argv.slice(2)
if (output === undefined || sources.length === 0) {
  console.error('usage: node scripts/make-ico.js <out.ico> <png…>')
  process.exit(1)
}

const images = sources.map((path) => {
  const bytes = readFileSync(path)
  // The PNG header carries the dimensions at a fixed offset, so the sizes are
  // read from the images rather than from their file names.
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return { bytes, width, height }
})

const HEADER = 6
const ENTRY = 16
const directory = Buffer.alloc(HEADER + ENTRY * images.length)
directory.writeUInt16LE(0, 0) // reserved
directory.writeUInt16LE(1, 2) // an icon, not a cursor
directory.writeUInt16LE(images.length, 4)

let offset = directory.length
images.forEach((image, at) => {
  const entry = HEADER + ENTRY * at
  // 256 is written as 0: the field is one byte wide.
  directory.writeUInt8(image.width >= 256 ? 0 : image.width, entry)
  directory.writeUInt8(image.height >= 256 ? 0 : image.height, entry + 1)
  directory.writeUInt8(0, entry + 2) // palette size: none, it is truecolor
  directory.writeUInt8(0, entry + 3) // reserved
  directory.writeUInt16LE(1, entry + 4) // planes
  directory.writeUInt16LE(32, entry + 6) // bits per pixel
  directory.writeUInt32LE(image.bytes.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += image.bytes.length
})

writeFileSync(output, Buffer.concat([directory, ...images.map((image) => image.bytes)]))
console.log(`wrote ${output} (${images.map((image) => image.width).join(', ')})`)
