const groups = [
  ['Sénégal', 'Senegal', 'Dakar', 'Thiès', 'Saint-Louis'], ['Bénin', 'Benin', 'Cotonou', 'Porto-Novo'],
  ['Côte d’Ivoire', 'Ivory Coast', 'Abidjan', 'Yamoussoukro'], ['Togo', 'Togo', 'Lomé'], ['Ghana', 'Ghana', 'Accra'],
  ['Burkina Faso', 'Burkina Faso', 'Ouagadougou'], ['Niger', 'Niger', 'Niamey'], ['Mali', 'Mali', 'Bamako'],
  ['Guinée', 'Guinea', 'Conakry'], ['Gabon', 'Gabon', 'Libreville'], ['Cameroun', 'Cameroon', 'Douala', 'Yaoundé'],
  ['RDC', 'Democratic Republic of the Congo', 'Kinshasa'], ['Rwanda', 'Rwanda', 'Kigali'], ['Kenya', 'Kenya', 'Nairobi'],
  ['Nigeria', 'Nigeria', 'Lagos', 'Abuja'], ['Afrique du Sud', 'South Africa', 'Johannesburg', 'Cape Town'],
  ['Maroc', 'Morocco', 'Casablanca', 'Rabat'], ['Tunisie', 'Tunisia', 'Tunis'], ['Algérie', 'Algeria', 'Alger'],
  ['France', 'France', 'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux', 'Nantes'], ['Belgique', 'Belgium', 'Bruxelles'],
  ['Canada', 'Canada', 'Montréal', 'Québec', 'Toronto', 'Vancouver'], ['Royaume-Uni', 'United Kingdom', 'London'],
  ['Allemagne', 'Germany', 'Berlin', 'Munich'], ['Portugal', 'Portugal', 'Lisbon'], ['Espagne', 'Spain', 'Madrid', 'Barcelona'],
  ['États-Unis', 'United States', 'New York', 'San Francisco', 'Austin'], ['Inde', 'India', 'Bangalore', 'Mumbai'],
];
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
const places = groups.flatMap(([country, english, ...cities]) => [
  { label: country, value: english, detail: 'Pays', aliases: `${country} ${english}` },
  ...cities.map(city => ({ label: city, value: city, detail: country, aliases: `${city} ${country} ${english}` })),
]);
export function suggestLocations(query, limit = 6) {
  const text = normalize(query);
  if (!text) return [];
  return places.filter(place => text.length < 3 ? normalize(place.aliases).split(/[\s-]+/).some(word => word.startsWith(text)) : normalize(place.aliases).includes(text)).sort((a, b) => Number(normalize(b.label).startsWith(text)) - Number(normalize(a.label).startsWith(text))).slice(0, limit);
}
export function attachLocationSuggestions(input, list, onSelect) {
  let suggestions = [], selected = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); selected = -1; };
  const highlight = () => {
    [...list.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === selected)));
    if (selected >= 0) input.setAttribute('aria-activedescendant', list.children[selected].id);
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = index => { if (!suggestions[index]) return; input.value = suggestions[index].value; close(); onSelect(); };
  const update = () => {
    suggestions = suggestLocations(input.value); selected = -1; list.replaceChildren();
    for (const [index, place] of suggestions.entries()) {
      const option = document.createElement('li'); option.id = `place-${index}`; option.role = 'option'; option.setAttribute('aria-selected', 'false');
      const label = document.createElement('strong'); label.textContent = place.label;
      const detail = document.createElement('span'); detail.textContent = place.detail;
      option.append(label, detail); option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => choose(index)); list.append(option);
    }
    list.hidden = !suggestions.length; input.setAttribute('aria-expanded', String(!!suggestions.length)); input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('input', event => { if (!event.isComposing) update(); });
  input.addEventListener('focus', update); input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) update(); if (!suggestions.length) return;
      event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; highlight();
    }
    if (event.key === 'Enter' && selected >= 0 && !list.hidden) { event.preventDefault(); choose(selected); }
  });
  return close;
}
