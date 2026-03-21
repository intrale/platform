#!/usr/bin/env node
// Fix literal newline in caption string (line 809)
const fs = require('fs');
const path = require('path');

const dispSrc = path.join(__dirname, '..', '.claude', 'hooks', 'commander', 'command-dispatcher.js');
let src = fs.readFileSync(dispSrc, 'utf8');

// The broken string has a literal newline between the two parts
const OLD_CAPTION = "        var caption = \"📊 <b>Intrale Monitor \u2014 \" + _tgApi.escHtml(label) + \"</b>\n\r\n\" + ts;";
const NEW_CAPTION = "        var caption = \"📊 <b>Intrale Monitor \u2014 \" + _tgApi.escHtml(label) + \"</b>\\n\" + ts;";

if (src.includes(OLD_CAPTION)) {
    src = src.replace(OLD_CAPTION, NEW_CAPTION);
    console.log('Fixed \\n caption (unix newline)');
} else {
    // Try with CRLF
    const OLD2 = "        var caption = \"📊 <b>Intrale Monitor \u2014 \" + _tgApi.escHtml(label) + \"</b>\r\n\r\n\" + ts;";
    if (src.includes(OLD2)) {
        src = src.replace(OLD2, NEW_CAPTION);
        console.log('Fixed \\r\\n caption (crlf)');
    } else {
        // Generic regex approach
        src = src.replace(
            /var caption = ("📊 <b>Intrale Monitor — " \+ _tgApi\.escHtml\(label\) \+ "<\/b>)[\r\n]+(["]\s*\+ ts;)/,
            'var caption = "📊 <b>Intrale Monitor \u2014 " + _tgApi.escHtml(label) + "</b>\\n" + ts;'
        );
        console.log('Fixed via regex');
    }
}

fs.writeFileSync(dispSrc, src, 'utf8');
console.log('Done');
