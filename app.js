// app.js pour GoodMaps

// Variables globales
let allPlaces = [];
let filteredPlaces = [];
let map;
let markers = [];
let searchTerm = '';
let userLocation = null;
let locationRequested = false;
let routingControl = null;

const SEARCH_KEYWORDS = {
    restaurant: ['restaurant', 'resto', 'manger', 'repas', 'dejeuner', 'déjeuner', 'diner', 'dîner', 'brunch', 'cantine'],
    cafe: ['cafe', 'café', 'boire', 'boisson', 'the', 'thé', 'pause', 'gouter', 'goûter', 'petit dejeuner', 'petit-dejeuner'],
    public_place: ['parc', 'jardin', 'square', 'promenade', 'espace vert', 'lieu public', 'balade', 'se balader']
};

const FEATURE_KEYWORDS = {
    wheelchair_accessible: ['accessible', 'fauteuil', 'pmr', 'roulant', 'mobilite', 'mobilité'],
    accessible_toilets: ['toilettes accessibles', 'toilettes', 'sanitaires'],
    braille_menu: ['braille', 'menu braille'],
    eco_friendly: ['bio', 'ecologique', 'écologique', 'eco', 'éco', 'responsable', 'durable', 'vert'],
    local_products: ['local', 'locaux', 'produits locaux', 'circuit court'],
    fair_trade: ['equitable', 'équitable', 'commerce equitable', 'commerce équitable']
};

const NEARBY_KEYWORDS = ['pres de moi', 'près de moi', 'autour de moi', 'proche', 'a proximite', 'à proximité', 'autour', 'near me'];
const STOP_WORDS = new Set(['je', 'veux', 'voudrais', 'souhaite', 'trouve', 'trouver', 'cherche', 'chercher', 'un', 'une', 'des', 'de', 'du', 'la', 'le', 'les', 'au', 'aux', 'pour', 'vers', 'dans', 'sur', 'en', 'mon', 'ma', 'mes', 'me', 'moi', 'pres', 'près', 'proche', 'autour', 'ici', 'aller', 'faire', 'peux', 'peut', 'veux', 'avoir', 'aller']);

// Source de données externe : API Overpass (OpenStreetMap) — données en direct, sans clé API
// Plusieurs miroirs sont essayés dans l'ordre pour plus de fiabilité
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];
const PARIS_CENTER = { latitude: 48.8566, longitude: 2.3522 };
const SEARCH_RADIUS_METERS = 1500;

// Construire la requête Overpass autour d'un point donné
// Restaurants/cafés sont quasi toujours des points (node), les parcs des contours (way)
function buildOverpassQuery(center, radius) {
    const filters = [
        'node["amenity"="restaurant"]["name"]',
        'node["amenity"="cafe"]["name"]',
        'way["leisure"="park"]["name"]'
    ];
    const body = filters
        .map(filter => `  ${filter}(around:${radius},${center.latitude},${center.longitude});`)
        .join('\n');
    return `[out:json][timeout:25];\n(\n${body}\n);\nout center 60;`;
}

// Déduire le type GoodMaps à partir des tags OpenStreetMap
function osmTypeToAppType(tags) {
    if (tags.amenity === 'restaurant') return 'restaurant';
    if (tags.amenity === 'cafe') return 'cafe';
    if (tags.leisure === 'park') return 'public_place';
    return null;
}

// Transformer un élément OpenStreetMap au format utilisé par l'application
function mapOverpassElement(element) {
    const tags = element.tags || {};
    const type = osmTypeToAppType(tags);
    if (!type) return null;

    const latitude = element.lat != null ? element.lat : (element.center && element.center.lat);
    const longitude = element.lon != null ? element.lon : (element.center && element.center.lon);
    if (latitude == null || longitude == null) return null;

    const address = [tags['addr:housenumber'], tags['addr:street']]
        .filter(Boolean)
        .join(' ')
        .trim();

    return {
        id: `osm_${element.type}_${element.id}`,
        name: tags.name,
        type,
        location: {
            address: address || 'Adresse non renseignée',
            city: tags['addr:city'] || tags['contact:city'] || tags['addr:suburb'] || '—',
            latitude,
            longitude
        },
        accessibility: {
            wheelchair_accessible: tags.wheelchair === 'yes',
            accessible_toilets: tags['toilets:wheelchair'] === 'yes',
            braille_menu: tags.braille === 'yes' || tags['menu:braille'] === 'yes'
        },
        ethics: {
            eco_friendly: tags.organic === 'yes' || tags.organic === 'only',
            local_products: tags['diet:local'] === 'yes' || tags.produce === 'local',
            fair_trade: tags.fair_trade === 'yes' || tags.fairtrade === 'yes'
        },
        rating: null, // OpenStreetMap ne fournit pas de note
        phone: tags.phone || tags['contact:phone'] || 'Non renseigné',
        opening_hours: tags.opening_hours || 'Non renseignés',
        last_updated: new Date().toISOString()
    };
}

// Récupérer les lieux en direct depuis OpenStreetMap autour d'un point
// On essaie chaque miroir jusqu'à obtenir une réponse valide
async function fetchPlacesAround(center, radius) {
    const query = buildOverpassQuery(center, radius);
    let data = null;
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: query
            });
            if (!response.ok) {
                throw new Error(`${endpoint} a répondu ${response.status}`);
            }
            data = await response.json();
            break;
        } catch (error) {
            console.warn('Miroir Overpass indisponible:', error.message);
            lastError = error;
        }
    }

    if (!data) {
        throw lastError || new Error('Aucun miroir Overpass disponible');
    }

    const places = (data.elements || [])
        .map(mapOverpassElement)
        .filter(Boolean);

    // Dédoublonnage par nom + coordonnées arrondies
    const seen = new Set();
    return places.filter(place => {
        const key = `${normalizeText(place.name)}@${place.location.latitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Charger les données depuis la source externe (Overpass), avec data.json en secours
async function loadData(center = PARIS_CENTER) {
    setLoadingState(true);
    try {
        const places = await fetchPlacesAround(center, SEARCH_RADIUS_METERS);
        if (places.length === 0) {
            throw new Error('Aucun lieu reçu depuis OpenStreetMap');
        }
        allPlaces = places;
        filteredPlaces = [...allPlaces];
        notifyDataSource(`🌍 ${places.length} lieux en direct depuis OpenStreetMap`);
    } catch (error) {
        console.error('Erreur lors du chargement depuis OpenStreetMap:', error);
        await loadFallbackData();
    } finally {
        setLoadingState(false);
    }
}

// Données de secours locales si la source externe est indisponible
async function loadFallbackData() {
    try {
        const response = await fetch('data.json');
        const data = await response.json();
        allPlaces = data.places;
        filteredPlaces = [...allPlaces];
        notifyDataSource('⚠️ Source externe indisponible — données de secours affichées');
    } catch (error) {
        console.error('Erreur lors du chargement des données de secours:', error);
        notifyDataSource('❌ Impossible de charger les lieux');
    }
}

// Recharger de vrais lieux autour de la zone actuellement affichée sur la carte
async function searchInThisArea() {
    if (!map) return;
    const center = map.getCenter();
    await loadData({ latitude: center.lat, longitude: center.lng });
    applyFilters();
}

// Afficher l'état de chargement dans la liste des résultats
function setLoadingState(isLoading) {
    if (!isLoading) return;
    const resultsContainer = document.getElementById('search-results');
    if (resultsContainer) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: #4B0082; font-style: italic;">⏳ Chargement des lieux en direct...</p>';
    }
}

// Mettre à jour le petit message indiquant la source des données
function notifyDataSource(message) {
    const status = document.getElementById('data-source-status');
    if (status) {
        status.textContent = message;
    }
}

// Formater l'affichage de la note (les données externes n'en ont pas)
function formatRating(rating) {
    return rating != null ? `⭐ ${rating}/5` : 'Non renseignée';
}

function normalizeText(text) {
    return (text || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeSearch(text) {
    return normalizeText(text)
        .split(' ')
        .filter(token => token && !STOP_WORDS.has(token));
}

function hasKeyword(text, keywords) {
    return keywords.some(keyword => normalizeText(text).includes(normalizeText(keyword)));
}

function getDistanceKm(origin, destination) {
    if (!origin || !destination) return null;

    const toRadians = value => value * Math.PI / 180;
    const earthRadiusKm = 6371;
    const latitudeDelta = toRadians(destination.latitude - origin.latitude);
    const longitudeDelta = toRadians(destination.longitude - origin.longitude);
    const startLatitude = toRadians(origin.latitude);
    const endLatitude = toRadians(destination.latitude);

    const a = Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2)
        + Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2)
        * Math.cos(startLatitude) * Math.cos(endLatitude);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
}

function formatDistance(distanceKm) {
    if (distanceKm === null || Number.isNaN(distanceKm)) return '';
    if (distanceKm < 1) {
        return `${Math.round(distanceKm * 1000)} m`;
    }
    return `${distanceKm.toFixed(1)} km`;
}

function buildSearchProfile(query) {
    const normalizedQuery = normalizeText(query);
    const tokens = tokenizeSearch(query);
    const requiredTypes = new Set();
    const requiredFeatures = {};

    Object.entries(SEARCH_KEYWORDS).forEach(([type, keywords]) => {
        if (hasKeyword(normalizedQuery, keywords)) {
            requiredTypes.add(type);
        }
    });

    Object.entries(FEATURE_KEYWORDS).forEach(([feature, keywords]) => {
        if (hasKeyword(normalizedQuery, keywords)) {
            requiredFeatures[feature] = true;
        }
    });

    const nearbyOnly = hasKeyword(normalizedQuery, NEARBY_KEYWORDS);

    return {
        normalizedQuery,
        tokens,
        nearbyOnly,
        requiredTypes,
        requiredFeatures
    };
}

function matchesSearchProfile(place, profile) {
    if (profile.requiredTypes.size > 0 && !profile.requiredTypes.has(place.type)) {
        return false;
    }

    if (profile.requiredFeatures.wheelchair_accessible && !place.accessibility.wheelchair_accessible) return false;
    if (profile.requiredFeatures.accessible_toilets && !place.accessibility.accessible_toilets) return false;
    if (profile.requiredFeatures.braille_menu && !place.accessibility.braille_menu) return false;
    if (profile.requiredFeatures.eco_friendly && !place.ethics.eco_friendly) return false;
    if (profile.requiredFeatures.local_products && !place.ethics.local_products) return false;
    if (profile.requiredFeatures.fair_trade && !place.ethics.fair_trade) return false;

    if (profile.tokens.length === 0) {
        return true;
    }

    const haystack = normalizeText([
        place.name,
        translateType(place.type),
        place.location.address,
        place.location.city,
        place.type
    ].join(' '));

    return profile.tokens.some(token => haystack.includes(token));
}

function scorePlace(place, profile) {
    const haystack = normalizeText([
        place.name,
        translateType(place.type),
        place.location.address,
        place.location.city,
        place.type
    ].join(' '));

    let score = 0;
    let distanceKm = null;

    if (profile.requiredTypes.has(place.type)) {
        score += 30;
    }

    if (profile.tokens.length > 0) {
        profile.tokens.forEach(token => {
            if (haystack.includes(token)) {
                score += 14;
                if (normalizeText(place.name).includes(token)) {
                    score += 10;
                }
            }
        });
    }

    if (userLocation) {
        distanceKm = getDistanceKm(userLocation, place.location);
        score += Math.max(0, 50 - (distanceKm * 12));
        if (profile.nearbyOnly) {
            score += Math.max(0, 20 - (distanceKm * 5));
        }
    }

    score += (place.rating || 0) * 2;

    return {
        place,
        score,
        distanceKm
    };
}

function sortPlacesForDisplay(places, query) {
    const profile = buildSearchProfile(query);
    const rankedPlaces = places
        .filter(place => matchesSearchProfile(place, profile))
        .map(place => scorePlace(place, profile))
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }

            if (left.distanceKm !== null && right.distanceKm !== null && left.distanceKm !== right.distanceKm) {
                return left.distanceKm - right.distanceKm;
            }

            return (right.place.rating || 0) - (left.place.rating || 0);
        });

    return rankedPlaces;
}

// Initialiser la carte
function initMap() {
    map = L.map('map').setView([48.8566, 2.3522], 13); // Centre sur Paris

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
}

function requestUserLocation() {
    if (locationRequested) return;
    locationRequested = true;

    if (!navigator.geolocation) {
        console.warn('La géolocalisation n\'est pas supportée par ce navigateur.');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            userLocation = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude
            };
            applyFilters();
        },
        (error) => {
            console.warn('Impossible de récupérer la position de l\'utilisateur:', error.message);
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
}

// Mettre à jour les marqueurs sur la carte
function updateMarkers() {
    // Supprimer les anciens marqueurs
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    // Ajouter les nouveaux marqueurs
    filteredPlaces.forEach(place => {
        const marker = L.marker([place.location.latitude, place.location.longitude]).addTo(map);
        marker.bindPopup(`<b>${place.name}</b><br>${place.location.address}`);
        marker.on('click', () => showPlaceDetails(place));
        markers.push(marker);
    });
}

// Afficher les résultats de recherche
function displaySearchResults(places) {
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '';

    if (places.length === 0) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: #4B0082; font-style: italic;">Aucun lieu trouvé en français pour cette recherche...</p>';
        return;
    }

    places.forEach(result => {
        const place = result.place || result;
        const distanceText = result.distanceKm !== null && result.distanceKm !== undefined
            ? `<p><strong>Distance:</strong> ${formatDistance(result.distanceKm)}</p>`
            : '';
        const resultItem = document.createElement('div');
        resultItem.className = 'search-result-item';
        resultItem.onclick = () => showPlaceDetails(place);

        const typeEmoji = getTypeEmoji(place.type);

        resultItem.innerHTML = `
            <h4>${typeEmoji} ${place.name}</h4>
            <p><strong>Type:</strong> ${translateType(place.type)}</p>
            <p><strong>Adresse:</strong> ${place.location.address}, ${place.location.city}</p>
            ${distanceText}
            <p><strong>Note:</strong> ${formatRating(place.rating)}</p>
        `;

        resultsContainer.appendChild(resultItem);
    });
}

// Traduire le type en français
function translateType(type) {
    const translations = {
        'restaurant': 'Restaurant',
        'cafe': 'Café',
        'public_place': 'Lieu public'
    };
    return translations[type] || type;
}

// Obtenir l'emoji du type
function getTypeEmoji(type) {
    const emojis = {
        'restaurant': '🍽️',
        'cafe': '☕',
        'public_place': '🏞️'
    };
    return emojis[type] || '📍';
}

// Afficher les détails d'un lieu
function showPlaceDetails(place) {
    const detailsSection = document.getElementById('place-details');
    const detailsContent = document.getElementById('details-content');

    const typeEmoji = getTypeEmoji(place.type);
    const distanceText = userLocation
        ? `<p><strong>Distance depuis vous:</strong> ${formatDistance(getDistanceKm(userLocation, place.location))}</p>`
        : '';

    detailsContent.innerHTML = `
        <h3>${typeEmoji} ${place.name}</h3>
        <p><strong>ID:</strong> ${place.id}</p>
        <p><strong>Type:</strong> ${translateType(place.type)}</p>
        <p><strong>Adresse:</strong> ${place.location.address}, ${place.location.city}</p>
        ${distanceText}
        <p><strong>Coordonnées:</strong> ${place.location.latitude}, ${place.location.longitude}</p>
        <p><strong>📞 Téléphone:</strong> ${place.phone}</p>
        <p><strong>🕒 Horaires d'ouverture:</strong> ${place.opening_hours}</p>
        <p><strong>Accessibilité:</strong></p>
        <ul>
            <li>♿ Fauteuil roulant: ${place.accessibility.wheelchair_accessible ? 'Oui' : 'Non'}</li>
            <li>🚪 Toilettes accessibles: ${place.accessibility.accessible_toilets ? 'Oui' : 'Non'}</li>
            <li>📖 Menu en braille: ${place.accessibility.braille_menu ? 'Oui' : 'Non'}</li>
        </ul>
        <p><strong>Éthique:</strong></p>
        <ul>
            <li>🌱 Éco-responsable: ${place.ethics.eco_friendly ? 'Oui' : 'Non'}</li>
            <li>🥕 Produits locaux: ${place.ethics.local_products ? 'Oui' : 'Non'}</li>
            <li>🤝 Commerce équitable: ${place.ethics.fair_trade ? 'Oui' : 'Non'}</li>
        </ul>
        <p><strong>Note:</strong> ${formatRating(place.rating)}</p>
        <p><strong>Dernière mise à jour:</strong> ${new Date(place.last_updated).toLocaleDateString('fr-FR')}</p>
        <button id="get-itinerary-btn" onclick="getItinerary('${place.id}')">🗺️ Obtenir l'itinéraire</button>
    `;

    detailsSection.style.display = 'block';

    // Centrer la carte sur le lieu
    if (map) {
        map.setView([place.location.latitude, place.location.longitude], 15);
    }
}

// Fermer les détails
function closeDetails() {
    document.getElementById('place-details').style.display = 'none';
    // Supprimer l'itinéraire si affiché
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
    // Vider les instructions
    document.getElementById('instructions-content').innerHTML = '';
}

// Obtenir l'itinéraire depuis la position actuelle
function getItinerary(placeId) {
    const place = allPlaces.find(p => p.id === placeId);
    if (!place) return;

    if (!navigator.geolocation) {
        alert('La géolocalisation n\'est pas supportée par ce navigateur.');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLng = position.coords.longitude;

            // Supprimer l'ancien itinéraire
            if (routingControl) {
                map.removeControl(routingControl);
            }

            // Créer le nouvel itinéraire
            routingControl = L.Routing.control({
                waypoints: [
                    L.latLng(currentLat, currentLng),
                    L.latLng(place.location.latitude, place.location.longitude)
                ],
                routeWhileDragging: false,
                show: false, // Masquer les instructions par défaut
                createMarker: function(i, waypoint, n) {
                    if (i === 0) {
                        return L.marker(waypoint.latLng, {
                            icon: L.icon({
                                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
                                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                                iconSize: [25, 41],
                                iconAnchor: [12, 41],
                                popupAnchor: [1, -34],
                                shadowSize: [41, 41]
                            })
                        }).bindPopup('Votre position');
                    } else {
                        return L.marker(waypoint.latLng).bindPopup(place.name);
                    }
                },
                lineOptions: {
                    styles: [{ color: '#FF69B4', weight: 6 }]
                }
            }).addTo(map);

            // Écouter l'événement routesfound pour afficher les instructions
            routingControl.on('routesfound', function(e) {
                const routes = e.routes;
                const instructions = routes[0].instructions;
                const instructionsContent = document.getElementById('instructions-content');
                instructionsContent.innerHTML = '';

                instructions.forEach((instruction, index) => {
                    const stepDiv = document.createElement('div');
                    stepDiv.innerHTML = `<strong>${index + 1}.</strong> ${instruction.text} (${instruction.distance.toFixed(0)}m)`;
                    instructionsContent.appendChild(stepDiv);
                });

                // Afficher la durée et distance totales
                const totalDiv = document.createElement('div');
                totalDiv.innerHTML = `<hr><strong>Total:</strong> ${Math.round(routes[0].summary.totalDistance / 1000 * 10) / 10} km, ${Math.round(routes[0].summary.totalTime / 60)} min`;
                totalDiv.style.fontWeight = 'bold';
                totalDiv.style.marginTop = '1rem';
                instructionsContent.appendChild(totalDiv);
            });

            // Centrer la carte sur l'itinéraire
            setTimeout(() => {
                const bounds = L.latLngBounds([
                    [currentLat, currentLng],
                    [place.location.latitude, place.location.longitude]
                ]);
                map.fitBounds(bounds, { padding: [20, 20] });
            }, 1000);
        },
        (error) => {
            alert('Erreur lors de l\'obtention de votre position: ' + error.message);
        }
    );
}

// Appliquer les filtres
function applyFilters() {
    const typeFilter = document.getElementById('type-filter').value;
    const wheelchairFilter = document.getElementById('wheelchair-filter').checked;
    const ecoFilter = document.getElementById('eco-filter').checked;
    const profile = buildSearchProfile(searchTerm);

    filteredPlaces = allPlaces.filter(place => {
        if (typeFilter && place.type !== typeFilter) return false;
        if (wheelchairFilter && !place.accessibility.wheelchair_accessible) return false;
        if (ecoFilter && !place.ethics.eco_friendly) return false;
        return matchesSearchProfile(place, profile);
    });

    const rankedPlaces = sortPlacesForDisplay(filteredPlaces, searchTerm);
    displaySearchResults(rankedPlaces);
    updateMarkers();
}

// Écouteurs d'événements
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    initMap();
    requestUserLocation();
    displaySearchResults(sortPlacesForDisplay(filteredPlaces, searchTerm));
    updateMarkers();

    // Filtres
    document.getElementById('type-filter').addEventListener('change', applyFilters);
    document.getElementById('wheelchair-filter').addEventListener('change', applyFilters);
    document.getElementById('eco-filter').addEventListener('change', applyFilters);

    // Recherche
    document.getElementById('search-input').addEventListener('input', (e) => {
        searchTerm = e.target.value;
        applyFilters();
    });

    // Fermer les détails
    document.getElementById('close-details').addEventListener('click', closeDetails);

    // Recharger de vrais lieux autour de la zone affichée
    document.getElementById('search-area-btn').addEventListener('click', searchInThisArea);
});
