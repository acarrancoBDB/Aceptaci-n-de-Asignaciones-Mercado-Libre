import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aplicarPlantilla, reglasQueCoinciden } from '../src/reglas.js'

const reglas = [
  { nombre: 'Urgencias', palabras: ['urgente', 'emergencia'], coincidencia: 'cualquiera' },
  { nombre: 'Pedidos', palabras: ['pedido', 'cliente'], coincidencia: 'todas' },
]
const nombres = (texto) => reglasQueCoinciden(texto, reglas).map((r) => r.nombre)

test('ignora mayúsculas y acentos', () => {
  assert.deepEqual(nombres('¡ES URGÉNTE revisar!'), ['Urgencias'])
})

test('"todas" exige todas las palabras', () => {
  assert.deepEqual(nombres('llegó un pedido'), [])
  assert.deepEqual(nombres('Pedido nuevo del cliente Pérez'), ['Pedidos'])
})

test('solo coincide con palabras completas', () => {
  assert.deepEqual(nombres('ya está expedido para los clientes'), [])
})

test('varias reglas a la vez', () => {
  assert.deepEqual(nombres('urgente: pedido del cliente'), ['Urgencias', 'Pedidos'])
})

test('plantilla reemplaza variables y deja intactas las desconocidas', () => {
  assert.equal(aplicarPlantilla('{autor} dijo {mensaje} {otra}', { autor: 'Ana', mensaje: 'hola' }), 'Ana dijo hola {otra}')
})
