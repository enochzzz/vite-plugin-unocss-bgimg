import { resolve } from 'node:path'
import type { Stats } from 'node:fs'
import { createReadStream, statSync } from 'node:fs'
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'
import { lookup } from 'mrmime'
import type { FileMap } from './servePlugin'

/**
 *
 * @param root
 * @param fileMap
 * @param uri
 * @returns
 */
function getFile(root: string, fileMap: FileMap, uri: string) {
  if (uri.endsWith('/'))
    uri = uri.slice(0, -1)

  const files = fileMap.get(uri)
  if (files && files[0]) {
    const file = files[0]
    const filepath = resolve(root, file.src)
    const stats = statSync(filepath)
    return { filepath, stats }
  }

  for (const [key, vals] of fileMap) {
    const dir = key.endsWith('/') ? key : `${key}/`
    if (!uri.startsWith(dir)) continue

    for (const val of vals) {
      const filepath = resolve(root, val.src, uri.slice(dir.length))
      try {
        const stats = statSync(filepath)
        return { filepath, stats }
      }
      catch {
        console.error('file not found')
      }
    }
    return undefined
  }

  return undefined
}

/**
 *
 * @param name
 * @param stats
 * @returns
 */
function getFileHeaders(name: string, stats: Stats) {
  let ctype = lookup(name) || ''
  if (ctype === 'text/html') ctype += ';charset=utf-8'

  const headers: OutgoingHttpHeaders = {
    'Content-Length': stats.size,
    'Content-Type': ctype,
    'Last-Modified': stats.mtime.toUTCString(),
    'ETag': `W/"${stats.size}-${stats.mtime.getTime()}"`,
    'Cache-Control': 'no-cache',
  }

  return headers
}

/**
 *
 * @param headers
 * @param res
 * @returns
 */
function getMergeHeaders(headers: OutgoingHttpHeaders, res: ServerResponse) {
  headers = { ...headers }

  for (const key in headers) {
    const tmp = res.getHeader(key)
    if (tmp) headers[key] = tmp
  }

  const contentTypeHeader = res.getHeader('content-type')
  if (contentTypeHeader)
    headers['Content-Type'] = contentTypeHeader

  return headers
}

/**
 *
 * @param req
 * @param res
 * @param file
 * @param stats
 * @returns
 */
function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  stats: Stats,
) {
  const staticHeaders = getFileHeaders(file, stats)

  if (req.headers['if-none-match'] === staticHeaders.ETag) {
    res.writeHead(304)
    res.end()
    return
  }

  let code = 200
  const headers = getMergeHeaders(staticHeaders, res)
  const opts: { start?: number; end?: number } = {}

  if (req.headers.range) {
    code = 206
    const [x, y] = req.headers.range.replace('bytes=', '').split('-')
    const end = (y ? parseInt(y, 10) : 0) || stats.size - 1
    const start = (x ? parseInt(x, 10) : 0) || 0
    opts.end = end
    opts.start = start

    if (start >= stats.size || end >= stats.size) {
      res.setHeader('Content-Range', `bytes */${stats.size}`)
      res.statusCode = 416
      res.end()
      return
    }

    headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`
    headers['Content-Length'] = end - start + 1
    headers['Accept-Ranges'] = 'bytes'
  }

  res.writeHead(code, headers)
  createReadStream(file, opts).pipe(res)
}

/**
 *
 * @param res
 * @param next
 * @returns
 */
function return404(res: ServerResponse, next: Function) {
  if (next) {
    next()
    return
  }
  res.statusCode = 404
  res.end()
}

/**
 *
 * @param root
 * @param fileMap
 * @returns
 */
export function serveMiddleware(
  root: string,
  fileMap: FileMap,
) {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function middleware(req: IncomingMessage, res: ServerResponse, next: Function) {
    let path = req.url
    if (!path)
      return res.end()

    if (path.includes('%')) {
      try {
        path = decodeURIComponent(path)
      }
      catch (err) {
        /* malform uri */
      }
    }

    const data = getFile(root, fileMap, path)
    if (!data) {
      return404(res, next)
      return
    }

    sendFile(req, res, data.filepath, data.stats)
  }
}
