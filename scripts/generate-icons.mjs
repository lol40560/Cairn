import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const buildDir = path.join(projectRoot, 'build')
const iconSourcePath = path.join(buildDir, 'icon.svg')
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

function traySvg(iconSource) {
  // 托盘图标保持透明背景，仅保留单色石头轮廓与透明的眼睛。
  return iconSource
    .replace(/<rect[^>]*\/>\s*/u, '')
    .replaceAll('#D15060', '#000000')
    .replaceAll('fill="#17171A"', 'fill="none"')
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
  await access(iconSourcePath)
  const iconSource = await readFile(iconSourcePath, 'utf8')
  await sharp(Buffer.from(iconSource)).png().toFile(iconPath)

  const icoInputs = await Promise.all(iconSizes.map((size) => sharp(iconPath).resize(size, size).png().toBuffer()))
  await writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(icoInputs))

  const traySource = traySvg(iconSource)
  await sharp(Buffer.from(traySource)).resize(16, 16).png().toFile(path.join(buildDir, 'trayTemplate.png'))
  await sharp(Buffer.from(traySource)).resize(32, 32).png().toFile(path.join(buildDir, 'trayTemplate@2x.png'))
  await createIcns()
  console.info('已生成 Cairn App 与托盘图标。')
}

await main()
