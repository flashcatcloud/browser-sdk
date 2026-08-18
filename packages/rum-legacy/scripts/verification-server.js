'use strict'

/*
 * Serves the verification page, the bundle, and a same-origin intake that records what it received.
 *
 * Recording the request is the point. On the browsers this package targets there is often no usable
 * console, and the failure that matters most — a request the intake refuses because of its headers —
 * is invisible from inside the page. The server keeps what arrived, the page reads it back and
 * renders it, and the whole round trip becomes observable on the device itself.
 *
 * No dependencies, so it runs anywhere, including a bare Windows box.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { printLog, runMain } = require('../../../scripts/lib/executionUtils')

const PORT = Number(process.env.PORT || 8099)
const PACKAGE_ROOT = path.join(__dirname, '..')
const BUNDLE = path.join(PACKAGE_ROOT, 'bundle', 'fc-rum-legacy.js')
const PAGE = path.join(PACKAGE_ROOT, 'verification', 'index.html')

const received = []

runMain(() => {
  const server = createServer()
  server.listen(PORT, () => {
    printLog(`verification page on http://localhost:${PORT}/`)
  })
})

function createServer() {
  return http.createServer((request, response) => {
    const url = request.url || '/'
    const pathname = url.split('?')[0]
    printLog(`${request.method} ${url}  UA: ${(request.headers['user-agent'] || '').slice(0, 60)}`)

    if (url.indexOf('/rum-intake/') === 0) {
      collectBody(request, (body) => {
        received.push({
          method: request.method,
          url,
          contentType: request.headers['content-type'] || null,
          userAgent: request.headers['user-agent'] || null,
          body,
          at: new Date().toISOString(),
        })
        // The intake answers 202; anything else would send the SDK down its retry path.
        response.writeHead(202, { 'Access-Control-Allow-Origin': '*' })
        response.end('')
      })
      return
    }

    if (url.indexOf('/received') === 0) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(received))
      return
    }

    if (url.indexOf('/reset') === 0) {
      received.length = 0
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('reset')
      return
    }

    if (url.indexOf('/fc-rum-legacy.js') === 0) {
      serveFile(response, BUNDLE, 'application/javascript')
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      serveFile(response, PAGE, 'text/html')
      return
    }

    response.writeHead(404)
    response.end('not found')
  })
}

function collectBody(request, callback) {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => callback(Buffer.concat(chunks).toString('utf-8')))
}

function serveFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404)
      response.end(`missing ${path.basename(filePath)} — build the package first`)
      return
    }
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    response.end(content)
  })
}
