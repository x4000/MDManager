// Context-menu items for toggling a file's membership in favorite groups.
// Each group toggles independently (a file can be in several groups). With no
// groups yet, offers a one-click "Add to Favorites" that creates a default one.
export function favoriteMenuItems(file, favorites, onChange) {
  const same = (f) => f.rootPath === file.rootPath && f.relPath === file.relPath;
  if (!favorites || favorites.length === 0) {
    return [{ label: 'Add to Favorites', action: () => onChange([{ name: 'Favorites', files: [file] }]) }];
  }
  return favorites.map((g) => {
    const isIn = g.files.some(same);
    return {
      label: `${isIn ? '★' : '☆'}  ${g.name}`,
      action: () => onChange(favorites.map((fg) => (fg.name === g.name
        ? { ...fg, files: isIn ? fg.files.filter((f) => !same(f)) : [...fg.files, file] }
        : fg))),
    };
  });
}
