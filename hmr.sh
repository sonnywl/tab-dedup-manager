
npm run build-dev
npm run build-content
npm run watch-copy &
cp ./public_firefox/manifest.json ./build/manifest.json
cd ./build
web-ext run &