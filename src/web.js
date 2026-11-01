import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Estado compartido que index.js va actualizando y la página consulta
export const estado = {
  conexion: 'iniciando', // iniciando | qr | conectado | reconectando
  qr: null, // data URL de la imagen del QR
  usuario: null,
  grupos: [],
  gruposOrigen: [],
  eventos: [], // últimas reglas activadas, la más reciente primero
}

export function registrarEvento(evento) {
  estado.eventos.unshift({ ...evento, hora: new Date().toISOString() })
  estado.eventos.length = Math.min(estado.eventos.length, 50)
}

function json(res, codigo, datos) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(datos))
}

// "2026-11-01" -> medianoche local de ese día; sin fecha, medianoche de hoy
function inicioDelDia(fecha) {
  const d = fecha ? new Date(`${fecha}T00:00:00`) : new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function iniciarServidorWeb({ puerto, carpetaPublica, alCerrarSesion, historial, resolverGrupo, pedirHistorial }) {
  const html = () => readFileSync(path.join(carpetaPublica, 'index.html'))

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html())
      }
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        return json(res, 200, estado)
      }
      if (req.method === 'POST' && url.pathname === '/api/cerrar-sesion') {
        await alCerrarSesion()
        res.writeHead(204)
        return res.end()
      }
      // /api/mensajes?grupo=<nombre o jid>&fecha=AAAA-MM-DD (por defecto hoy)
      if (req.method === 'GET' && url.pathname === '/api/mensajes') {
        const jid = resolverGrupo(url.searchParams.get('grupo') ?? '')
        if (!jid) return json(res, 404, { error: 'Grupo no encontrado' })
        const desde = inicioDelDia(url.searchParams.get('fecha'))
        const hasta = desde + 24 * 60 * 60 * 1000
        return json(res, 200, historial.mensajes(jid, { desde }).filter((m) => m.ts < hasta))
      }
      // Pide a WhatsApp mensajes más antiguos del grupo; llegan después por el evento de historial
      if (req.method === 'POST' && url.pathname === '/api/historial') {
        const jid = resolverGrupo(url.searchParams.get('grupo') ?? '')
        if (!jid) return json(res, 404, { error: 'Grupo no encontrado' })
        await pedirHistorial(jid, Number(url.searchParams.get('cantidad') ?? 50), url.searchParams.get('antesDe'))
        return json(res, 202, { ok: true })
      }
      res.writeHead(404)
      res.end()
    } catch (err) {
      json(res, 500, { error: err.message })
    }
  })

  // Solo localhost: el QR da acceso a tu WhatsApp, no debe verse desde la red
  servidor.listen(puerto, '127.0.0.1', () => {
    console.log(`🌐 Interfaz disponible en http://localhost:${puerto}`)
  })
}
