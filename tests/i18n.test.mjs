import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslator, localeFromCookies, parseLocale } from '../app/lib/i18n.ts';
import en from '../app/locales/en.json' with { type: 'json' };
import es from '../app/locales/es.json' with { type: 'json' };

test('English is the default, including missing, unsupported and malformed preferences', () => {
  for (const value of [null, undefined, '', 'fr', 'en', '__proto__']) assert.equal(parseLocale(value), 'en');
  for (const cookie of [null, '', 'theme=dark', 'locale=fr', 'locale=%E0%A4%A', 'otherlocale=es']) {
    assert.equal(localeFromCookies(cookie), 'en', String(cookie));
  }
  assert.equal(localeFromCookies('theme=dark;locale=es; other=1'), 'es');
  assert.equal(localeFromCookies('theme=dark; locale=%65%73'), 'es');
});

test('catalogs have matching keys and interpolation variables', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(en)) {
    assert.ok(en[key] && es[key], key);
    assert.deepEqual(placeholders(en[key]), placeholders(es[key]), key);
  }
});

test('translators isolate locales, interpolate safely, and support singular and plural counts', () => {
  const english = createTranslator('en'), spanish = createTranslator('es');
  assert.equal(english('Settings'), 'Settings');
  assert.equal(spanish('Settings'), 'Ajustes');
  assert.equal(english('Settings'), 'Settings');
  assert.equal(english('messages.count', { count: 0 }), '0 messages');
  assert.equal(english('messages.count', { count: 1 }), '1 message');
  assert.equal(spanish('messages.count', { count: 1 }), '1 mensaje');
  assert.equal(spanish('messages.count', { count: 2 }), '2 mensajes');
  assert.equal(english('demo.remaining', { count: 1 }), 'Up to 1 more message');
  assert.equal(spanish('Switch to {model}', { model: '$& <model>' }), 'Cambiar a $& <model>');
  assert.equal(english('Remove {name}'), 'Remove {name}');
});

test('descriptor fallbacks and legacy app errors are localized without losing unknown messages', () => {
  const t = createTranslator('en');
  assert.equal(t('No pude mandar el mensaje'), 'Could not send the message');
  assert.equal(t('Campo inválido: command'), 'Invalid field: command');
  assert.equal(t('El agente no abrió la sesión a tiempo (revisa las extensiones activas: demo).'), 'The agent did not open the session in time (check active extensions: demo).');
  assert.equal(t('Conexión perdida (sin código); reintento 2 en 3 s.'), 'Connection lost (no code); retry 2 in 3 s.');
  assert.equal(t('unknown.id', { name: 'Sam' }, 'Hello {name}'), 'Hello Sam');
  assert.equal(t('External agent error'), 'External agent error');
  assert.equal(t('toString'), 'toString');
  assert.equal(t('__proto__'), '__proto__');
  assert.equal(createTranslator('es')('dialog.close'), 'Cerrar');
});
