import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Guarda los mensajes de grupos en data/mensajes/<jid>.jsonl (una línea JSON por mensaje)
export function crearHistorial(carpeta) {
  mkdirSync(carpeta, { recursive: true })
  const cache = new Map() // jid -> mensajes ya cargados

  const ruta = (jid) => path.join(carpeta, `${jid}.jsonl`)

  function leer(jid) {
    if (!cache.has(jid)) {
      const lineas = existsSync(ruta(jid)) ? readFileSync(ruta(jid), 'utf8').split('\n').filter(Boolean) : []
      cache.set(jid, lineas.map((l) => JSON.parse(l)))
    }
    return cache.get(jid)
  }

  return {
    // Devuelve true si el mensaje era nuevo
    guardar(registro) {
      const mensajes = leer(registro.jid)
      if (mensajes.some((m) => m.id === registro.id)) return false
      mensajes.push(registro)
      appendFileSync(ruta(registro.jid), JSON.stringify(registro) + '\n')
      return true
    },
    mensajes(jid, { desde = 0 } = {}) {
      return leer(jid)
        .filter((m) => m.ts >= desde)
        .sort((a, b) => a.ts - b.ts)
    },
    masAntiguo(jid) {
      return leer(jid).reduce((min, m) => (!min || m.ts < min.ts ? m : min), null)
    },
  }
}
