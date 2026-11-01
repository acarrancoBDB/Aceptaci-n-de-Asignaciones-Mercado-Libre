# Bot WhatsApp BDB

Escucha uno o varios grupos de WhatsApp y, cuando alguien escribe ciertas palabras clave, envía un mensaje a otros grupos.

## Arranque

```bash
npm install
npm start
```

La primera vez aparece un QR en la terminal: en el teléfono ve a **WhatsApp > Dispositivos vinculados > Vincular un dispositivo** y escanéalo. La sesión se guarda en `auth/`, así que las siguientes veces no pide QR.

Al conectar, el bot guarda la lista de tus grupos (nombre y JID) en `data/grupos.json`.

## Configurar reglas: `config/reglas.json`

- `gruposOrigen`: grupos que se escuchan (nombre exacto o JID).
- `reglas`: cada una tiene
  - `palabras`: palabras clave (no importan mayúsculas ni acentos; se busca la palabra completa).
  - `coincidencia`: `"cualquiera"` (basta una) o `"todas"`.
  - `destinos`: grupos donde se publica la respuesta.
  - `plantilla`: texto a enviar. Variables: `{autor}`, `{mensaje}`, `{grupo}`, `{fecha}`.

Los cambios al archivo se aplican sin reiniciar el bot.

## Pruebas

```bash
npm test
```

## Notas

- Usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial de WhatsApp Web. WhatsApp puede bloquear números que automatizan mensajes; usa un número dedicado y evita enviar en volumen.
- La carpeta `auth/` da acceso completo a tu WhatsApp: no la compartas ni la subas a git.
- Si cierras la sesión desde el teléfono, borra `auth/` y vuelve a escanear.
