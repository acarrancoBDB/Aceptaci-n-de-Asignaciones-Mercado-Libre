import { readFileSync, statSync } from 'node:fs'

// Minúsculas y sin acentos, para que "URGENTÉ" y "urgente" coincidan
export function normalizar(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function contienePalabra(textoNormalizado, palabra) {
  const p = normalizar(palabra).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Palabra completa: "pedido" no debe disparar con "pedidos" ni "expedido"
  return new RegExp(`(^|[^\\p{L}\\p{N}])${p}($|[^\\p{L}\\p{N}])`, 'u').test(textoNormalizado)
}

export function reglasQueCoinciden(texto, reglas) {
  const t = normalizar(texto)
  return reglas.filter((regla) => {
    const hits = regla.palabras.map((p) => contienePalabra(t, p))
    return regla.coincidencia === 'todas' ? hits.every(Boolean) : hits.some(Boolean)
  })
}

export function aplicarPlantilla(plantilla, datos) {
  return plantilla.replace(/\{(\w+)\}/g, (completo, clave) => datos[clave] ?? completo)
}

// Recarga el archivo solo si cambió, así puedes editar reglas sin reiniciar el bot
let cache = { mtime: 0, config: null }
export function cargarConfig(ruta) {
  const mtime = statSync(ruta).mtimeMs
  if (mtime !== cache.mtime) {
    cache = { mtime, config: JSON.parse(readFileSync(ruta, 'utf8')) }
  }
  return cache.config
}
