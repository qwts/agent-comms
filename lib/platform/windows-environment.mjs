// Classic Windows PowerShell must build its own module path. A Node child of
// pwsh inherits PS7 modules that powershell.exe cannot load. Normalize only
// the child environment, retaining every other caller setting.
export function windowsPowershellEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}
