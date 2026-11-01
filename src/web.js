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

export function iniciarServidorWeb({ puerto, carpetaPublica, alCerrarSesion }) {
  const html = () => readFileSync(path.join(carpetaPublica, 'index.html'))

  const servidor = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html())
    }
    if (req.method === 'GET' && req.url === '/api/estado') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(estado))
    }
    if (req.method === 'POST' && req.url === '/api/cerrar-sesion') {
      await alCerrarSesion()
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(404)
    res.end()
  })

  // Solo localhost: el QR da acceso a tu WhatsApp, no debe verse desde la red
  servidor.listen(puerto, '127.0.0.1', () => {
    console.log(`🌐 Interfaz disponible en http://localhost:${puerto}`)
  })
}
