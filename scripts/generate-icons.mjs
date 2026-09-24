import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const buildDir = path.join(projectRoot, 'build')
const logoPath = path.join(projectRoot, 'src', 'assets', 'logo.svg')
const iconPath = path.join(buildDir, 'icon.png')
const iconsetDir = path.join(buildDir, 'icon.iconset')

const iconSizes = [16, 32, 48, 64, 128, 256]
const icnsSizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]

function backgroundSvg(size) {
  const radius = Math.round(size * 0.18)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1A1D21"/><stop offset="1" stop-color="#22262B"/></linearGradient></defs><rect width="${size}" height="${size}" rx="${radius}" fill="url(#background)"/></svg>`
}

function traySvg(size) {
  const scale = size / 1024
  const point = (value) => value * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g fill="#000000" stroke="#000000" stroke-width="${point(20)}" stroke-linecap="round"><path d="M${point(390)} ${point(390)} ${point(320)} ${point(560)}M${point(634)} ${point(390)} ${point(704)} ${point(560)}M${point(320)} ${point(680)} ${point(455)} ${point(770)}M${point(704)} ${point(680)} ${point(569)} ${point(770)}" fill="none"/><circle cx="${point(512)}" cy="${point(260)}" r="${point(110)}"/><circle cx="${point(240)}" cy="${point(620)}" r="${point(80)}"/><circle cx="${point(784)}" cy="${point(620)}" r="${point(80)}"/><circle cx="${point(512)}" cy="${point(800)}" r="${point(70)}"/></g></svg>`
}

async function commandExists(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function createIcns() {
  if (process.platform !== 'darwin' || !(await commandExists('iconutil'))) {
    console.warn('跳过 icon.icns：iconutil 仅在 macOS 上可用。')
    return
  }

  await rm(iconsetDir, { recursive: true, force: true })
  await mkdir(iconsetDir, { recursive: true })
  await Promise.all(icnsSizes.map(async ([size, filename]) => {
    await sharp(iconPath).resize(size, size).png().toFile(path.join(iconsetDir, filename))
  }))
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], { stdio: 'inherit' })
}

async function main() {
  await mkdir(buildDir, { recursive: true })
  await access(logoPath)
  const logo = await readFile(logoPath)
  const iconLogo = await sharp(logo).resize(717, 717, { fit: 'contain' }).png().toBuffer()

  await sharp(Buffer.from(backgroundSvg(1024)))
    .composite([{ input: iconLogo, left: 154, top: 154 }])
    .png()
    .toFile(iconPath)

  const icoInputs = await Promise.all(iconSizes.map((size) => sharp(iconPath).resize(size, size).png().toBuffer()))
  await writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(icoInputs))

  await sharp(Buffer.from(traySvg(16))).png().toFile(path.join(buildDir, 'trayTemplate.png'))
  await sharp(Buffer.from(traySvg(32))).png().toFile(path.join(buildDir, 'trayTemplate@2x.png'))
  await createIcns()
  console.info('已生成 Cairn App 与托盘图标。')
}

await main()
