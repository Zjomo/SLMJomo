const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const template = fs.readFileSync('./templates/index_pro.html', 'utf8');
const menu = template.match(/<nav class="menu-items">([\s\S]*?)<\/nav>/)?.[1];
assert.ok(menu, 'top menu should exist');

const htmlIds = new Set([...template.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const menuLinks = [...menu.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, label]) => {
    const getAttribute = name => attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || null;
    return {
        href: getAttribute('href'),
        label: label.replace(/<[^>]*>/g, '').trim(),
        disabled: getAttribute('aria-disabled') === 'true',
        unavailableMessage: getAttribute('data-unavailable-message')
    };
});

assert.equal(menuLinks.length, 6);
for (const link of menuLinks.filter(item => !item.disabled)) {
    assert.ok(link.href?.startsWith('#'), `${link.label} should use an in-page target`);
    assert.ok(htmlIds.has(link.href.slice(1)), `${link.label} target ${link.href} should exist`);
}
assert.equal(menuLinks.find(item => item.label.includes('首页')).href, '#fresnel');
assert.equal(menuLinks.find(item => item.label.includes('图案库')).href, '#fresnel');
assert.equal(menuLinks.find(item => item.label.includes('序列')).href, '#sequence-panel');
assert.equal(menuLinks.find(item => item.label.includes('绘图板')).href, '#paint-board');
for (const label of ['校正', '设置']) {
    const link = menuLinks.find(item => item.label.includes(label));
    assert.ok(link?.disabled, `${label} should remain visibly unavailable`);
    assert.match(link.unavailableMessage, new RegExp(label));
}

const scrolledTargets = [];
const notifications = [];
const menuElements = menuLinks.map(link => {
    const classes = new Set(link.label.includes('首页') ? ['active'] : []);
    return {
        href: link.href,
        disabled: link.disabled,
        unavailableMessage: link.unavailableMessage,
        getAttribute(name) {
            if (name === 'href') return this.href;
            if (name === 'aria-disabled') return this.disabled ? 'true' : null;
            if (name === 'data-unavailable-message') return this.unavailableMessage;
            return null;
        },
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); }
        }
    };
});
const sectionElements = new Map(['fresnel', 'sequence-panel', 'paint-board'].map(id => [id, {
    id,
    scrollIntoView() { scrolledTargets.push(id); }
}]));
const context = vm.createContext({
    document: {
        addEventListener() {},
        createElement() { return { style: {}, textContent: '' }; },
        head: { appendChild() {} },
        getElementById(id) { return sectionElements.get(id) || null; },
        querySelectorAll(selector) { return selector === '.menu-item' ? menuElements : []; },
        querySelector() { return null; }
    },
    showNotification(message, kind) { notifications.push({ message, kind }); }
});
vm.runInContext(fs.readFileSync('./static/js/pro_main.js', 'utf8'), context);
context.showNotification = (message, kind) => notifications.push({ message, kind });

const sequenceLink = menuElements.find(item => item.href === '#sequence-panel');
let defaultPrevented = false;
assert.equal(context.switchTab({
    currentTarget: sequenceLink,
    preventDefault() { defaultPrevented = true; }
}), true);
assert.equal(defaultPrevented, true);
assert.deepEqual(scrolledTargets, ['sequence-panel']);
assert.equal(sequenceLink.classList.contains('active'), true);
assert.equal(menuElements[0].classList.contains('active'), false);

const calibrationLink = menuElements.find(item => item.disabled && item.unavailableMessage.includes('校正'));
defaultPrevented = false;
assert.equal(context.switchTab({
    currentTarget: calibrationLink,
    preventDefault() { defaultPrevented = true; }
}), false);
assert.equal(defaultPrevented, true);
assert.equal(sequenceLink.classList.contains('active'), true);
assert.equal(notifications.at(-1).message, '校正视图尚未实现');

process.stdout.write('Passed 6 top-navigation routing checks.\n');
