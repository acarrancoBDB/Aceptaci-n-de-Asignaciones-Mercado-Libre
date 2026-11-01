import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import { aplicarPlantilla, cargarConfig, normalizar, reglasQueCoinciden } from './reglas.js'
import { estado, iniciarServidorWeb, registrarEvento } from './web.js'
import { crearHistorial } from './historial.js'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUTA_AUTH = path.join(raiz, 'auth')
const RUTA_REGLAS = path.join(raiz, 'config', 'reglas.json')
const RUTA_GRUPOS = path.join(raiz, 'data', 'grupos.json')
const RUTA_MEDIA = path.join(raiz, 'data', 'media')
const PUERTO = Number(process.env.PORT ?? 3000)

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

let sock = null
const historial = crearHistorial(path.join(raiz, 'data', 'mensajes'))

// nombre normalizado -> jid, y jid -> nombre
let gruposPorNombre = new Map()
let nombresPorJid = new Map()
// IDs de mensajes que envió el bot, para no reaccionar a sus propias respuestas
const enviadosPorBot = new Set()

async function actualizarGrupos(sock) {
  const grupos = await sock.groupFetchAllParticipating()
  gruposPorNombre = new Map()
  nombresPorJid = new Map()
  for (const g of Object.values(grupos)) {
    gruposPorNombre.set(normalizar(g.subject), g.id)
    nombresPorJid.set(g.id, g.subject)
  }
  estado.grupos = Object.values(grupos)
    .map((g) => ({ nombre: g.subject, jid: g.id }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  estado.gruposOrigen = cargarConfig(RUTA_REGLAS).gruposOrigen.map(resolverGrupo).filter(Boolean)
  mkdirSync(path.dirname(RUTA_GRUPOS), { recursive: true })
  writeFileSync(RUTA_GRUPOS, JSON.stringify(estado.grupos, null, 2))
  console.log(`📋 ${estado.grupos.length} grupos encontrados (lista en data/grupos.json)`)
}

function registrarGrupo({ id, subject }) {
  const anterior = nombresPorJid.get(id)
  if (anterior === subject) return
  if (anterior) gruposPorNombre.delete(normalizar(anterior))
  gruposPorNombre.set(normalizar(subject), id)
  nombresPorJid.set(id, subject)
  estado.grupos = [...estado.grupos.filter((g) => g.jid !== id), { nombre: subject, jid: id }]
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}

// Acepta el nombre del grupo o directamente su JID (...@g.us)
function resolverGrupo(nombreOJid) {
  if (nombreOJid.endsWith('@g.us')) return nombreOJid
  return gruposPorNombre.get(normalizar(nombreOJid))
}

function extraerTexto(m) {
  const msg = m.message
  if (!msg) return ''
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    ''
  )
}

async function procesarMensaje(m) {
  const jid = m.key.remoteJid
  if (!jid?.endsWith('@g.us') || enviadosPorBot.has(m.key.id)) return

  const texto = extraerTexto(m)
  if (!texto) return

  const config = cargarConfig(RUTA_REGLAS)
  const origenes = new Set(config.gruposOrigen.map(resolverGrupo).filter(Boolean))
  if (!origenes.has(jid)) return

  const coincidencias = reglasQueCoinciden(texto, config.reglas)
  if (coincidencias.length === 0) return

  const nombreGrupo = nombresPorJid.get(jid) ?? jid
  const datos = {
    autor: m.pushName ?? 'Alguien',
    mensaje: texto,
    grupo: nombreGrupo,
    fecha: new Date(Number(m.messageTimestamp) * 1000).toLocaleString('es-MX'),
  }

  for (const regla of coincidencias) {
    console.log(`🔑 Regla "${regla.nombre}" activada por ${datos.autor} en ${nombreGrupo}`)
    const respuesta = aplicarPlantilla(regla.plantilla, datos)
    const enviadosA = []
    for (const destino of regla.destinos) {
      const destinoJid = resolverGrupo(destino)
      if (!destinoJid) {
        console.warn(`⚠️  No encontré el grupo destino "${destino}". Revisa data/grupos.json`)
        continue
      }
      const enviado = await sock.sendMessage(destinoJid, { text: respuesta })
      if (enviado?.key?.id) enviadosPorBot.add(enviado.key.id)
      enviadosA.push(nombresPorJid.get(destinoJid) ?? destinoJid)
      console.log(`   ↳ enviado a ${enviadosA.at(-1)}`)
    }
    registrarEvento({ regla: regla.nombre, autor: datos.autor, grupo: nombreGrupo, destinos: enviadosA })
  }
}

const TIPOS_MEDIA = { imageMessage: 'imagen', videoMessage: 'video', documentMessage: 'documento', documentWithCaptionMessage: 'documento', audioMessage: 'audio', stickerMessage: 'sticker' }

function guardarEnHistorial(m) {
  const jid = m.key?.remoteJid
  if (!jid?.endsWith('@g.us') || !m.message) return
  const clave = Object.keys(m.message).find((k) => TIPOS_MEDIA[k])
  const texto = extraerTexto(m)
  if (!texto && !clave) return
  const doc = m.message.documentMessage ?? m.message.documentWithCaptionMessage?.message?.documentMessage
  const tipo = clave ? TIPOS_MEDIA[clave] : 'texto'
  const nuevo = historial.guardar({
    id: m.key.id,
    jid,
    autor: m.pushName ?? null,
    // En mensajes del historial el autor viene en m.participant, no en la key
    participante: m.key.participant ?? m.participant ?? null,
    deMi: Boolean(m.key.fromMe),
    ts: Number(m.messageTimestamp) * 1000,
    tipo,
    archivo: doc?.fileName ?? null,
    texto,
  })
  // Las asignaciones llegan como imagen o documento: guardamos el archivo de los grupos que escuchamos
  if (nuevo && (tipo === 'imagen' || tipo === 'documento') && esGrupoOrigen(jid)) {
    descargarMedia(m, tipo, doc?.fileName).catch((err) => console.error(`No pude descargar ${m.key.id}:`, err.message))
  }
}

function esGrupoOrigen(jid) {
  return cargarConfig(RUTA_REGLAS).gruposOrigen.map(resolverGrupo).includes(jid)
}

async function descargarMedia(m, tipo, nombreArchivo) {
  const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  const ext = tipo === 'imagen' ? '.jpg' : path.extname(nombreArchivo ?? '') || '.bin'
  mkdirSync(RUTA_MEDIA, { recursive: true })
  writeFileSync(path.join(RUTA_MEDIA, `${m.key.id}${ext}`), buffer)
  console.log(`📎 ${tipo} guardado en data/media/${m.key.id}${ext}`)
}

let intentos = 0

async function iniciar() {
  // Cerramos el socket anterior: dos conexiones con la misma sesión se expulsan entre sí (código 440)
  sock?.ev.removeAllListeners()
  sock?.end(undefined)

  const { state, saveCreds } = await useMultiFileAuthState(RUTA_AUTH)
  const { version } = await fetchLatestBaileysVersion()
  // Nombre con el que aparece en "Dispositivos vinculados", junto a WhatsApp Web
  const actual = makeWASocket({ version, auth: state, logger, browser: Browsers.windows('Bot BDB') })
  sock = actual

  actual.ev.on('creds.update', saveCreds)

  actual.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (sock !== actual) return
    if (qr) {
      estado.conexion = 'qr'
      estado.qr = await QRCode.toDataURL(qr, { margin: 1, width: 400 })
      console.log(`📱 Nuevo QR listo en http://localhost:${PUERTO}`)
    }
    if (connection === 'open') {
      intentos = 0
      console.log('✅ Conectado a WhatsApp')
      estado.conexion = 'conectado'
      estado.qr = null
      estado.usuario = actual.user?.name ?? actual.user?.id?.split(':')[0] ?? null
      // La lista de grupos solo se pide una vez: pedirla en cada reconexión provoca "rate-overlimit"
      if (estado.grupos.length === 0) {
        await actualizarGrupos(actual).catch((err) => console.error('No pude obtener los grupos:', err.message))
      }
      const { gruposOrigen } = cargarConfig(RUTA_REGLAS)
      for (const g of gruposOrigen) {
        if (!resolverGrupo(g)) console.warn(`⚠️  No encontré el grupo origen "${g}". Revisa data/grupos.json`)
      }
      console.log(`👂 Escuchando: ${gruposOrigen.join(', ')}`)
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      estado.qr = null
      if (codigo === DisconnectReason.connectionReplaced) {
        // WhatsApp Web es otro dispositivo y no causa esto; solo pasa si otra copia del bot usa auth/.
        // Se reintenta, pero con la espera larga para no pelear con esa otra copia.
        console.warn('⚠️  Otra conexión con esta misma sesión reemplazó al bot. ¿Hay otra copia del bot corriendo?')
        intentos = Math.max(intentos, 4)
      }
      if (codigo === DisconnectReason.loggedOut) {
        // La sesión ya no sirve: la borramos para que la página muestre un QR nuevo
        console.log('🔒 Sesión cerrada, generando un QR nuevo...')
        rmSync(RUTA_AUTH, { recursive: true, force: true })
        estado.usuario = null
        estado.grupos = []
      }
      // Espera creciente entre intentos (máx. 60 s) para no saturar a WhatsApp
      const espera = Math.min(60_000, 2_000 * 2 ** intentos++)
      console.log(`🔄 Conexión cerrada (código ${codigo}), reintento en ${espera / 1000} s`)
      estado.conexion = 'reconectando'
      setTimeout(iniciar, espera)
    }
  })

  // Grupos nuevos o renombrados: se actualizan con los datos del evento, sin volver a pedir
  // la lista completa (WhatsApp manda muchos de estos eventos y responde con "rate-overlimit")
  actual.ev.on('groups.upsert', (grupos) => grupos.forEach(registrarGrupo))
  actual.ev.on('groups.update', (cambios) => cambios.filter((c) => c.subject).forEach(registrarGrupo))

  // Historial que manda WhatsApp al vincular o cuando se pide con fetchMessageHistory
  actual.ev.on('messaging-history.set', ({ messages }) => {
    for (const m of messages) guardarEnHistorial(m)
    console.log(`🗂️  Historial recibido: ${messages.length} mensajes`)
  })

  actual.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      guardarEnHistorial(m)
      if (type !== 'notify') continue
      try {
        await procesarMensaje(m)
      } catch (err) {
        console.error('Error procesando mensaje:', err)
      }
    }
  })
}

// Pide a WhatsApp mensajes anteriores a `antesDeId`, o al más antiguo que tenemos de ese grupo
async function pedirHistorial(jid, cantidad = 50, antesDeId = null) {
  const ancla = antesDeId ? historial.mensajes(jid).find((m) => m.id === antesDeId) : historial.masAntiguo(jid)
  if (!ancla) throw new Error('Aún no hay ningún mensaje guardado de ese grupo para usar como punto de partida')
  await sock.fetchMessageHistory(
    cantidad,
    { remoteJid: jid, id: ancla.id, fromMe: ancla.deMi, participant: ancla.participante ?? undefined },
    Math.floor(ancla.ts / 1000)
  )
}

// Un error suelto de WhatsApp no debe tumbar el bot completo
process.on('unhandledRejection', (err) => console.error('Error no controlado:', err?.message ?? err))

iniciarServidorWeb({
  puerto: PUERTO,
  carpetaPublica: path.join(raiz, 'public'),
  // logout() dispara connection.update con loggedOut, que borra auth/ y genera un QR nuevo
  alCerrarSesion: () => sock?.logout().catch(() => {}),
  historial,
  resolverGrupo,
  pedirHistorial,
})
iniciar()
