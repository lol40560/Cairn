import { execFileSync } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const buildDir = path.join(projectRoot, 'build')
const iconSourcePath = path.join(projectRoot, 'src', 'assets', 'cairn-logo.png')
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
  try {
    await access(iconSourcePath)
  } catch {
    console.warn('未生成图标：等待 src/assets/cairn-logo.png。')
    return
  }
  await sharp(iconSourcePath).resize(1024, 1024).png().toFile(iconPath)

  const icoInputs = await Promise.all(iconSizes.map((size) => sharp(iconPath).resize(size, size).png().toBuffer()))
  await writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(icoInputs))

  // 托盘图标只保留原始透明度，将图形统一为系统可着色的黑色。
  const { data, info } = await sharp(iconSourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = Buffer.alloc(info.width * info.height)
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = data[index * info.channels + 3]
  }
  const traySource = sharp({
    create: { background: '#000000', channels: 3, height: info.height, width: info.width },
  }).joinChannel(alpha, { raw: { channels: 1, height: info.height, width: info.width } })
  await traySource.clone().resize(16, 16).png().toFile(path.join(buildDir, 'trayTemplate.png'))
  await traySource.resize(32, 32).png().toFile(path.join(buildDir, 'trayTemplate@2x.png'))
  await createIcns()
  console.info('已生成 Cairn App 与托盘图标。')
}

await main()
