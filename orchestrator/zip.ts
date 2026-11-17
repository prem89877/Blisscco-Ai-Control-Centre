import { inflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { validatePath, scanSecrets } from '../agent2/guard.js'
import { AgentError } from '../agent2/util.js'

export const ZIP_LIMITS = { archiveBytes: 2_000_000, files: 40, fileBytes: 200_000, totalBytes: 600_000, ratio: 100 }
const TEXT_EXTENSIONS = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json','.md','.mdx','.css','.scss','.html','.htm','.xml','.svg','.txt','.sql','.yml','.yaml','.toml','.ini','.sh','.py','.go','.rs','.java','.kt','.swift'])
const TEXT_NAMES = new Set(['dockerfile','.gitignore','.gitattributes','.env.example','.npmrc.example','.blisscco-delete.txt'])
function supportedTextPath(path: string): boolean {
  const base = path.split('/').pop()!.toLowerCase()
  const dot = base.lastIndexOf('.')
  return TEXT_NAMES.has(base) || (dot >= 0 && TEXT_EXTENSIONS.has(base.slice(dot)))
}
export interface ZipEntry { path: string; content: string; bytes: number; sha256: string; sql: boolean; secrets: {rule:string;line:number}[] }

export function inspectZip(input: string): { entries: ZipEntry[]; totalBytes: number; checksum: string; ignored: string[] } {
  if (typeof input !== 'string' || input.length > Math.ceil(ZIP_LIMITS.archiveBytes * 4 / 3) + 8) throw new AgentError('ZIP upload exceeds 2 MB limit', 413, 'zip_too_large')
  const buf = Buffer.from(input, 'base64')
  if (!buf.length || buf.length > ZIP_LIMITS.archiveBytes || buf.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) throw new AgentError('Invalid ZIP/base64 upload', 400, 'bad_zip')
  let eocd = -1
  for (let i = Math.max(0, buf.length - 65557); i <= buf.length - 22; i++) if (buf.readUInt32LE(i) === 0x06054b50) eocd = i
  if (eocd < 0) throw new AgentError('ZIP central directory not found', 400, 'bad_zip')
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16)
  if (count > ZIP_LIMITS.files || cdOff + cdSize > eocd || count === 0) throw new AgentError('ZIP file count/structure exceeds limits', 400, 'zip_limits')
  const entries: ZipEntry[] = []; const ignored: string[] = []; const seen = new Set<string>(); let total = 0; let pos = cdOff
  for (let n=0;n<count;n++) {
    if (buf.readUInt32LE(pos)!==0x02014b50) throw new AgentError('Invalid ZIP directory entry',400,'bad_zip')
    const made=buf.readUInt16LE(pos+4), flags=buf.readUInt16LE(pos+8), method=buf.readUInt16LE(pos+10), crc=buf.readUInt32LE(pos+16), csize=buf.readUInt32LE(pos+20), usize=buf.readUInt32LE(pos+24), nl=buf.readUInt16LE(pos+28), el=buf.readUInt16LE(pos+30), cl=buf.readUInt16LE(pos+32), ext=buf.readUInt32LE(pos+38), off=buf.readUInt32LE(pos+42)
    const raw=buf.subarray(pos+46,pos+46+nl).toString('utf8'); pos += 46+nl+el+cl
    if (!raw || raw.endsWith('/')) continue
    // OS metadata that archive tools add on their own: skipped (and reported), never extracted.
    if (/^__MACOSX\//.test(raw) || /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(raw)) { ignored.push(raw.slice(0,200)); continue }
    const path=validatePath(raw)
    if (!supportedTextPath(path)) throw new AgentError('Unsupported file type: '+path,400,'unsupported_file')
    if (seen.has(path.toLowerCase())) throw new AgentError('Duplicate ZIP path: '+path,400,'duplicate_path')
    seen.add(path.toLowerCase())
    const unix=(made>>8)===3, mode=ext>>>16
    if (unix && (mode & 0o170000)===0o120000) throw new AgentError('Symlink entry rejected: '+path,400,'zip_symlink')
    // bit 3 (data descriptor) is accepted: sizes and CRC are read from the central directory and verified below.
    if ((flags & 1)!==0 || (flags & 64)!==0) throw new AgentError('Encrypted ZIP entries are unsupported',400,'zip_unsupported')
    if (![0,8].includes(method)) throw new AgentError('Unsupported ZIP compression method',400,'zip_unsupported')
    if (usize>ZIP_LIMITS.fileBytes || (csize===0 ? usize>0 : usize/csize>ZIP_LIMITS.ratio)) throw new AgentError('ZIP entry exceeds size/compression limits: '+path,413,'zip_bomb')
    if (off+30>buf.length || buf.readUInt32LE(off)!==0x04034b50) throw new AgentError('Invalid ZIP local header',400,'bad_zip')
    const lnl=buf.readUInt16LE(off+26), lel=buf.readUInt16LE(off+28), start=off+30+lnl+lel
    if (start+csize>buf.length) throw new AgentError('Truncated ZIP entry',400,'bad_zip')
    const compressed=buf.subarray(start,start+csize)
    const data=method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:ZIP_LIMITS.fileBytes})
    if(data.length!==usize || crc32(data)!==crc) throw new AgentError('ZIP integrity check failed: '+path,400,'bad_zip')
    if(data.includes(0)) throw new AgentError('Binary files are unsupported: '+path,400,'binary_file')
    const content=data.toString('utf8')
    if(!Buffer.from(content,'utf8').equals(data)) throw new AgentError('Non-UTF8 files are unsupported: '+path,400,'binary_file')
    const hits=scanSecrets(content)
    if(hits.length) throw new AgentError('Secret scan blocked '+path+' ('+hits.slice(0,4).map(x=>x.rule+' line '+x.line).join(', ')+')',422,'secret_detected')
    total+=data.length
    if(total>ZIP_LIMITS.totalBytes) throw new AgentError('Total extracted content exceeds 600 KB',413,'zip_bomb')
    entries.push({path,content,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),sql:/\.sql$/i.test(path),secrets:hits})
  }
  if(!entries.length) throw new AgentError('ZIP contains no supported files',400,'empty_zip')
  return {entries,totalBytes:total,checksum:createHash('sha256').update(buf).digest('hex'),ignored}
}
function crc32(b:Buffer){let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (~c)>>>0}
