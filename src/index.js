import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { aplicarPlantilla, cargarConfig, normalizar, reglasQueCoinciden } from './reglas.js'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUTA_AUTH = path.join(raiz, 'auth')
const RUTA_REGLAS = path.join(raiz, 'config', 'reglas.json')
const RUTA_GRUPOS = path.join(raiz, 'data', 'grupos.json')

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

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
  mkdirSync(path.dirname(RUTA_GRUPOS), { recursive: true })
  writeFileSync(
    RUTA_GRUPOS,
    JSON.stringify(Object.values(grupos).map((g) => ({ nombre: g.subject, jid: g.id })), null, 2)
  )
  console.log(`📋 ${grupos ? Object.keys(grupos).length : 0} grupos encontrados (lista en data/grupos.json)`)
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

async function procesarMensaje(sock, m) {
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
    for (const destino of regla.destinos) {
      const destinoJid = resolverGrupo(destino)
      if (!destinoJid) {
        console.warn(`⚠️  No encontré el grupo destino "${destino}". Revisa data/grupos.json`)
        continue
      }
      const enviado = await sock.sendMessage(destinoJid, { text: respuesta })
      if (enviado?.key?.id) enviadosPorBot.add(enviado.key.id)
      console.log(`   ↳ enviado a ${nombresPorJid.get(destinoJid) ?? destinoJid}`)
    }
  }
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(RUTA_AUTH)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR desde WhatsApp > Dispositivos vinculados > Vincular un dispositivo:\n')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp')
      await actualizarGrupos(sock)
      const { gruposOrigen } = cargarConfig(RUTA_REGLAS)
      for (const g of gruposOrigen) {
        if (!resolverGrupo(g)) console.warn(`⚠️  No encontré el grupo origen "${g}". Revisa data/grupos.json`)
      }
      console.log(`👂 Escuchando: ${gruposOrigen.join(', ')}`)
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      if (codigo === DisconnectReason.loggedOut) {
        console.error('❌ Sesión cerrada desde el teléfono. Borra la carpeta auth/ y vuelve a iniciar para escanear el QR.')
        process.exit(1)
      }
      console.log(`🔄 Conexión cerrada (código ${codigo}), reconectando...`)
      iniciar()
    }
  })

  // Si te agregan a un grupo o le cambian el nombre, refrescamos la lista
  sock.ev.on('groups.upsert', () => actualizarGrupos(sock).catch(() => {}))
  sock.ev.on('groups.update', () => actualizarGrupos(sock).catch(() => {}))

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      try {
        await procesarMensaje(sock, m)
      } catch (err) {
        console.error('Error procesando mensaje:', err)
      }
    }
  })
}

iniciar()
