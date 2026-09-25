// All observations are injected functions; importing this module reads no state.
export function setupSteps(probes) {
  const mode = probes.mode();
  const profile = mode.profile;
  const hosted = profile === 'hosted';
  const installation = probes.install(profile);
  const agents = probes.agents().filter((name) => name !== 'local');
  const army = probes.army();
  const roles = Object.values(army?.roles ?? {});
  const rolesDone = roles.length > 0 && (!hosted || roles.every((role) => role.agent !== 'local'));
  const repo = probes.repo();
  const step = (id, title, status, detail, command) => ({ id, title, status, detail, command });
  const modeDetail = !profile ? 'choose where models run' : profile === 'remote' ? `remote ${mode.host}:${mode.port}` : ['hosted', 'bedrock'].includes(profile) ? profile : `local ${profile}`;
  const installed = installation.marker ? installation.marker.profile === profile : Boolean(installation.version && installation.registered);
  return [
    step('mode', 'Where models run', profile ? 'done' : 'todo', modeDetail, ['setup', '--choose']),
    step('install', 'Installed', installed ? 'done' : 'todo', installation.version || 'OpenClaw not found', ['install']),
    step('agents', 'Agents', agents.length ? 'done' : hosted ? 'todo' : 'skipped', agents.length ? agents.join(', ') : hosted ? 'add a hosted agent' : 'optional: the local model works without one', ['agents', 'add']),
    step('roles', 'Roles', rolesDone ? 'done' : 'todo', rolesDone ? `${roles.length} roles` : !agents.length ? 'add an agent first' : hosted && roles.length ? 'roles must use a hosted agent' : 'define an army', agents.length ? ['army', 'init', '--agent', agents[0], '--force', ...(army?.repairLayer ? [`--${army.repairLayer}`] : [])] : ['army', 'init', '--agent', 'local', '--force']),
    step('repo', 'This repo', !repo.inside ? 'skipped' : repo.configured ? 'done' : 'todo', !repo.inside ? 'run nomarmy setup inside a project to set it up' : repo.configured ? '.nomarmy.yml exists' : 'configure this project', ['init']),
    step('check', 'Check', 'todo', 'verify the installation', ['doctor']),
  ];
}

export function formatSetupSteps(steps) {
  const first = steps.findIndex((step) => step.status === 'todo');
  return steps.map((step, i) => `${step.status === 'done' ? '✓' : step.status === 'skipped' ? '–' : i === first ? '→' : ' '} ${step.title}: ${step.detail}`).join('\n');
}

export async function runSetupPlaybook({ evaluate, ask, run, print }) {
  for (;;) {
    const steps = await evaluate();
    print(formatSetupSteps(steps));
    const next = steps.find((step) => step.status === 'todo');
    if (!next) return 0;
    const answer = (await ask('Run it now? [Y/n] ')).trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') {
      print('Resume with: nomarmy setup');
      return 0;
    }
    const code = await run(next.command);
    if (code !== 0) {
      print(`Setup step failed: ${next.title} (exit ${code})`);
      return code;
    }
    if (next.id === 'check') {
      print('Setup complete');
      print('Restart Claude Code in the project and ask it to use nomArmy.');
      return 0;
    }
  }
}
