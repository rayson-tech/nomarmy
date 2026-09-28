/** Docker, Git, and repository metadata paths are POSIX paths, even on Windows. */
export function toPosix(value) {
  return value.replaceAll("\\", "/");
}
