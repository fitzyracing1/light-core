import { pack, lightOf, createGitHub, type Light, type Program } from '@fitzyracing1/light-core';
const l: Light = lightOf('success');
const b: number = pack([l, { lit: false }]);
const gh = createGitHub({ token: 'x' });
const p: Program = {
  name: 'x',
  async run() {
    return { light: 'lit', findings: [] };
  },
};
void [b, gh, p];
