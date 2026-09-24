#!/bin/bash
# togif.sh <segment> [width] [fps]: cuts one segment out of its take into ../<segment>.gif.
# A take marks its segments (lib.ts#record); each mark leaves $TAKES/<segment>.cut.
set -e
cd "$(dirname "$0")"
TAKES=${TAKES:-${TMPDIR:-/tmp}/digsite-takes}
n=$1; w=${2:-800}; fps=${3:-10}
read -r ss dur src < "$TAKES/$n.cut" || true
pal="$TAKES/$n.palette.png"
ffmpeg -y -loglevel error -ss "$ss" -t "$dur" -i "$TAKES/$src.webm" -vf "fps=$fps,scale=$w:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=160" "$pal"
ffmpeg -y -loglevel error -ss "$ss" -t "$dur" -i "$TAKES/$src.webm" -i "$pal" -lavfi "fps=$fps,scale=$w:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "../$n.gif"
rm "$pal"
ls -la "../$n.gif" | awk '{print $5/1e6 " MB", $9}'
