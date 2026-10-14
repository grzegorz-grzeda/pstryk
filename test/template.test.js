import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTemplate, render, TemplateError } from '../src/template.js';

const ctx = { body: { room: 'kitchen', on: true, level: 42, msg: 'say "hi"', nested: { a: [1, 2] } }, query: { x: '1' }, hook: { name: 'h' } };

test('substitutes values by path', () => {
  assert.equal(render('home/{{body.room}}/light', ctx), 'home/kitchen/light');
  assert.equal(render('{{ body.level }}-{{query.x}}-{{hook.name}}', ctx), '42-1-h');
  assert.equal(render('{"on": {{body.on}}}', ctx), '{"on": true}');
});

test('objects become JSON, |json escapes strings', () => {
  assert.equal(render('{{body.nested}}', ctx), '{"a":[1,2]}');
  assert.equal(render('{"m": {{body.msg|json}}}', ctx), '{"m": "say \\"hi\\""}');
});

test('missing values are errors', () => {
  assert.throws(() => render('{{body.nope}}', ctx), TemplateError);
  assert.throws(() => render('{{body.constructor}}', ctx), TemplateError);
  assert.throws(() => render('{{body.__proto__}}', ctx), TemplateError);
});

test('topic mode rejects values that change topic structure', () => {
  for (const room of ['a/b', '+', '#', 'x\u0000']) {
    assert.throws(() => render('home/{{body.room}}', { body: { room } }, { topic: true }), TemplateError);
  }
  assert.equal(render('home/{{body.room}}', { body: { room: 'a/b' } }), 'home/a/b');
});

test('checkTemplate validates topics and placeholders', () => {
  assert.deepEqual(checkTemplate('home/{{body.room}}/set', { topic: true }), []);
  assert.ok(checkTemplate('home/#', { topic: true }).length);
  assert.ok(checkTemplate('home/+/x', { topic: true }).length);
  assert.ok(checkTemplate('$SYS/x', { topic: true }).length);
  assert.ok(checkTemplate('', { topic: true }).length);
  assert.ok(checkTemplate('{{ body.x').length);
  assert.ok(checkTemplate('{{1bad}}').length);
});
