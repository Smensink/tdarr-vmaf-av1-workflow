#!/usr/bin/env node
// Test script to verify GPU VMAF (libvmaf_cuda) works correctly
// This emulates the calculateVMAF plugin's GPU VMAF command building and execution

var fs = require('fs');
var path = require('path');
var execSync = require('child_process').execSync;

console.log('=== GPU VMAF Test Script (Node.js) ===\n');

// Configuration - matches plugin settings
var ffmpegPath = 'tdarr-ffmpeg';
var cacheDir = '/temp/test-vmaf-' + Date.now();
var modelPath = process.env.VMAF_MODEL_PATH || '/usr/local/share/model/vmaf_v0.6.1.json';

// Create test directory
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}
console.log('Test directory: ' + cacheDir + '\n');

// Check if libvmaf_cuda is available
console.log('1. Checking for libvmaf_cuda support...');
try {
    var env = Object.assign({}, process.env);
    if (!env.LD_LIBRARY_PATH || env.LD_LIBRARY_PATH.indexOf('/usr/local/lib') === -1) {
        var libraryPath = '/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib';
        if (env.LD_LIBRARY_PATH) {
            libraryPath = libraryPath + ':' + env.LD_LIBRARY_PATH;
        }
        env.LD_LIBRARY_PATH = libraryPath;
    }

    var output = execSync('"' + ffmpegPath + '" -hide_banner -filters 2>&1', {
        encoding: 'utf8',
        shell: true,
        timeout: 10000,
        env: env,
        maxBuffer: 10 * 1024 * 1024
    });

    if (output.indexOf('libvmaf_cuda') !== -1) {
        console.log('   ✅ libvmaf_cuda is available\n');
    } else {
        console.log('   ❌ libvmaf_cuda is NOT available\n');
        process.exit(1);
    }
} catch (e) {
    console.log('   ❌ Error checking libvmaf_cuda: ' + e.message + '\n');
    process.exit(1);
}

// Create deterministic, self-contained fixtures. Do not reuse arbitrary /temp files:
// they may belong to an active Tdarr job, have unrelated frames, or be incomplete.
console.log('2. Creating deterministic GPU fixtures...');
var referenceFile = cacheDir + '/reference_h264_nvenc.mkv';
var distortedFile = cacheDir + '/distorted_av1_nvenc.mkv';

try {
    execSync('"' + ffmpegPath + '" -hide_banner -loglevel error -f lavfi -i testsrc2=duration=2:size=1280x720:rate=30 -c:v h264_nvenc -preset p7 -tune hq -rc vbr -cq 15 -b:v 0 -pix_fmt yuv420p -t 2 "' + referenceFile + '" -y', {
        encoding: 'utf8',
        shell: true,
        timeout: 120000,
        env: env,
        maxBuffer: 10 * 1024 * 1024
    });
    console.log('   Created reference: ' + referenceFile);
} catch (e) {
    console.log('   ❌ Could not create H.264 NVENC reference: ' + (e.stderr || e.message));
    process.exit(1);
}

try {
    execSync('"' + ffmpegPath + '" -hide_banner -loglevel error -f lavfi -i testsrc2=duration=2:size=1280x720:rate=30 -c:v av1_nvenc -preset p7 -tune hq -rc vbr -cq 45 -b:v 0 -pix_fmt yuv420p -t 2 "' + distortedFile + '" -y', {
        encoding: 'utf8',
        shell: true,
        timeout: 120000,
        env: env,
        maxBuffer: 10 * 1024 * 1024
    });
    console.log('   Created distorted: ' + distortedFile);
} catch (e) {
    console.log('   ❌ Could not create AV1 NVENC distortion: ' + (e.stderr || e.message));
    process.exit(1);
}
console.log('');

// Detect reference codec (simulate inputFileObj.ffProbeData)
console.log('3. Detecting reference file codec...');
var referenceCodec = 'h264';
var referenceCuvid = 'h264_cuvid';
try {
    var probeOutput = execSync('ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "' + referenceFile + '" 2>&1', {
        encoding: 'utf8',
        shell: true,
        env: env
    });
    referenceCodec = probeOutput.trim().toLowerCase();
    console.log('   Reference codec: ' + referenceCodec);

    // Map codec to CUVID decoder (matches plugin logic)
    switch (referenceCodec) {
        case 'h264':
            referenceCuvid = 'h264_cuvid';
            break;
        case 'hevc':
        case 'h265':
            referenceCuvid = 'hevc_cuvid';
            break;
        case 'av1':
            referenceCuvid = 'av1_cuvid';
            break;
        case 'vp8':
            referenceCuvid = 'vp8_cuvid';
            break;
        case 'vp9':
            referenceCuvid = 'vp9_cuvid';
            break;
        case 'vc1':
            referenceCuvid = 'vc1_cuvid';
            break;
        case 'mpeg2video':
        case 'mpeg2':
            referenceCuvid = 'mpeg2_cuvid';
            break;
        case 'mpeg4':
            referenceCuvid = 'mpeg4_cuvid';
            break;
        default:
            referenceCuvid = null;
            console.log('   ⚠️  Codec not supported by CUVID, will use software decode');
            break;
    }

    if (referenceCuvid) {
        console.log('   Using CUVID decoder: ' + referenceCuvid);
    }
} catch (e) {
    console.log('   ⚠️  Could not detect codec, using default h264_cuvid');
}
console.log('');

// Build GPU VMAF command (matches plugin's buildGpuVmafCommand function)
console.log('4. Building GPU VMAF command...');
var logPath = cacheDir + '/vmaf_test.json';
var modelParam = '';
if (fs.existsSync(modelPath)) {
    modelParam = ':model=path=' + modelPath;
    console.log('   Using VMAF model: ' + modelPath);
} else {
    console.log('   ⚠️  Model file not found, using default');
}
console.log('');

// Build command parts (exact match to plugin)
var cmdParts = [
    '"' + ffmpegPath + '"',
    '-init_hw_device', 'cuda=cuda0:0',
    '-filter_hw_device', 'cuda0',
    '-hwaccel', 'cuda',
    '-hwaccel_device', '0',
    '-hwaccel_output_format', 'cuda',
    '-c:v', 'av1_cuvid',
    '-i', '"' + distortedFile + '"'
];

var filterComplex = '';
if (referenceCuvid) {
    // Both files use CUVID decoding
    cmdParts.push('-hwaccel', 'cuda');
    cmdParts.push('-hwaccel_device', '0');
    cmdParts.push('-hwaccel_output_format', 'cuda');
    cmdParts.push('-c:v', referenceCuvid);
    cmdParts.push('-i', '"' + referenceFile + '"');
    filterComplex = '[0:v]scale_cuda=format=yuv420p[dis];[1:v]scale_cuda=format=yuv420p[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam;
} else {
    // Reference uses software decode
    cmdParts.push('-i', '"' + referenceFile + '"');
    filterComplex = '[0:v]scale_cuda=format=yuv420p[dis];[1:v]hwupload_cuda,scale_cuda=format=yuv420p[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam;
}

cmdParts.push('-filter_complex', '"' + filterComplex + '"');
cmdParts.push('-f', 'null', '-');

var fullCommand = cmdParts.join(' ');
console.log('5. Executing GPU VMAF command...');
console.log('   Command: ' + fullCommand.substring(0, 200) + '...\n');

// Execute command
var startTime = Date.now();
try {
    var result = execSync(fullCommand, {
        encoding: 'utf8',
        shell: true,
        env: env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000 // 5 minutes
    });

    var duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('   ✅ GPU VMAF command succeeded in ' + duration + 's\n');

    // Check and parse results
    if (fs.existsSync(logPath)) {
        console.log('6. Parsing VMAF results...');
        try {
            var logContent = fs.readFileSync(logPath, 'utf8');
            var jsonData = JSON.parse(logContent);

            if (jsonData.pooled_metrics && jsonData.pooled_metrics.vmaf) {
                var vmaf = jsonData.pooled_metrics.vmaf;
                console.log('   VMAF Score (harmonic mean): ' + (vmaf.harmonic_mean || 'N/A'));
                console.log('   VMAF Score (mean): ' + (vmaf.mean || 'N/A'));
                console.log('   VMAF Score (min): ' + (vmaf.min || 'N/A'));
                console.log('   VMAF Score (max): ' + (vmaf.max || 'N/A'));
            } else if (jsonData.aggregate_metrics && jsonData.aggregate_metrics.vmaf) {
                console.log('   VMAF Score: ' + jsonData.aggregate_metrics.vmaf);
            } else {
                console.log('   ⚠️  Could not find VMAF scores in JSON');
                console.log('   Log file: ' + logPath);
            }
        } catch (e) {
            console.log('   ⚠️  Could not parse VMAF results: ' + e.message);
            console.log('   Log file: ' + logPath);
        }
    } else {
        console.log('   ⚠️  Warning: VMAF log file not created at ' + logPath);
    }

    console.log('\n=== Test Complete ===');
    console.log('✅ GPU VMAF is working correctly!');
    console.log('Log file: ' + logPath);
    process.exit(0);

} catch (err) {
    var duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('   ❌ GPU VMAF command FAILED after ' + duration + 's\n');

    // Extract meaningful error
    var stderr = err.stderr ? err.stderr.toString() : '';
    var stdout = err.stdout ? err.stdout.toString() : '';
    var errorMsg = stderr || stdout || err.message;

    // Filter out version info
    var errorLines = errorMsg.split('\n').filter(function(line) {
        var trimmed = line.trim();
        return trimmed.length > 0 &&
               trimmed.indexOf('ffmpeg version') === -1 &&
               trimmed.indexOf('Copyright') === -1 &&
               trimmed.indexOf('built with') === -1 &&
               trimmed.indexOf('configuration:') === -1 &&
               trimmed.indexOf('libav') === -1;
    });

    console.log('   Error details:');
    if (errorLines.length > 0) {
        errorLines.slice(0, 20).forEach(function(line) {
            console.log('   ' + line);
        });
    } else {
        console.log('   ' + errorMsg.substring(0, 500));
    }

    console.log('\n=== Test Failed ===');
    console.log('❌ GPU VMAF is not working. Check errors above.');
    process.exit(1);
}
