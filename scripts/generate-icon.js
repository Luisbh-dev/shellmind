const sharp = require('sharp');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'src', 'assets', 'logo.png');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const OUTPUT_PNG = path.join(BUILD_DIR, 'icon.png');
const OUTPUT_ICO = path.join(BUILD_DIR, 'icon.ico');

async function main() {
    // Ensure build directory exists
    if (!fs.existsSync(BUILD_DIR)) {
        fs.mkdirSync(BUILD_DIR, { recursive: true });
    }

    // Resize to 256x256 square with transparent padding
    await sharp(INPUT)
        .resize(256, 256, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toFile(OUTPUT_PNG);

    console.log('✅ Created build/icon.png (256x256)');

    // Convert to ICO for Windows
    const icoBuf = await pngToIco.default(OUTPUT_PNG);
    fs.writeFileSync(OUTPUT_ICO, icoBuf);
    console.log('✅ Created build/icon.ico');
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
