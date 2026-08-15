/**
 * @file src/components/settings/HomeSettings.jsx
 * @brief Consolidated manager details screen for Home settings properties.
 * 
 * Fetches and updates physical home address coordinates, binds sub-forms (HomeSettingsGeneral,
 * HomeSettingsGeofencing), renders interactive Leaflet maps with custom marker pins and geofence circles,
 * and updates background geofencing radius parameters (100m to 1500m).
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';


import Spinner from '../common/Spinner';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getHomeDetails, updateHomeDetails, updateHomeGeolocation, updateAwayRadius } from '../../api/homes';
import { getHomeTimezone, updateHomeTimezone } from '../../api/tanoclo';


import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';

import HomeSettingsGeneral from './HomeSettingsGeneral';
import HomeSettingsGeofencing from './HomeSettingsGeofencing';

const _countries = [
  { code: 'ABW', name: 'Aruba' },
  { code: 'AFG', name: 'Afghanistan' },
  { code: 'AGO', name: 'Angola' },
  { code: 'AIA', name: 'Anguilla' },
  { code: 'ALA', name: 'Åland Islands' },
  { code: 'ALB', name: 'Albania' },
  { code: 'AND', name: 'Andorra' },
  { code: 'ARE', name: 'United Arab Emirates' },
  { code: 'ARG', name: 'Argentina' },
  { code: 'ARM', name: 'Armenia' },
  { code: 'ASM', name: 'American Samoa' },
  { code: 'ATA', name: 'Antarctica' },
  { code: 'ATF', name: 'French Southern Territories' },
  { code: 'ATG', name: 'Antigua and Barbuda' },
  { code: 'AUS', name: 'Australia' },
  { code: 'AUT', name: 'Austria' },
  { code: 'AZE', name: 'Azerbaijan' },
  { code: 'BDI', name: 'Burundi' },
  { code: 'BEL', name: 'Belgium' },
  { code: 'BEN', name: 'Benin' },
  { code: 'BES', name: 'Bonaire, Sint Eustatius and Saba' },
  { code: 'BFA', name: 'Burkina Faso' },
  { code: 'BGD', name: 'Bangladesh' },
  { code: 'BGR', name: 'Bulgaria' },
  { code: 'BHR', name: 'Bahrain' },
  { code: 'BHS', name: 'Bahamas' },
  { code: 'BIH', name: 'Bosnia and Herzegovina' },
  { code: 'BLM', name: 'Saint Barthélemy' },
  { code: 'BLR', name: 'Belarus' },
  { code: 'BLZ', name: 'Belize' },
  { code: 'BMU', name: 'Bermuda' },
  { code: 'BOL', name: 'Bolivia' },
  { code: 'BRA', name: 'Brazil' },
  { code: 'BRB', name: 'Barbados' },
  { code: 'BRN', name: 'Brunei Darussalam' },
  { code: 'BTN', name: 'Bhutan' },
  { code: 'BVT', name: 'Bouvet Island' },
  { code: 'BWA', name: 'Botswana' },
  { code: 'CAF', name: 'Central African Republic' },
  { code: 'CAN', name: 'Canada' },
  { code: 'CCK', name: 'Cocos (Keeling) Islands' },
  { code: 'CHE', name: 'Switzerland' },
  { code: 'CHL', name: 'Chile' },
  { code: 'CHN', name: 'China' },
  { code: 'CIV', name: 'Côte d\'Ivoire' },
  { code: 'CMR', name: 'Cameroon' },
  { code: 'COD', name: 'Democratic Republic of the Congo' },
  { code: 'COG', name: 'Congo' },
  { code: 'COK', name: 'Cook Islands' },
  { code: 'COL', name: 'Colombia' },
  { code: 'COM', name: 'Comoros' },
  { code: 'CPV', name: 'Cabo Verde' },
  { code: 'CRI', name: 'Costa Rica' },
  { code: 'CUB', name: 'Cuba' },
  { code: 'CUW', name: 'Curaçao' },
  { code: 'CXR', name: 'Christmas Island' },
  { code: 'CYM', name: 'Cayman Islands' },
  { code: 'CYP', name: 'Cyprus' },
  { code: 'CZE', name: 'Czechia' },
  { code: 'DEU', name: 'Germany' },
  { code: 'DJI', name: 'Djibouti' },
  { code: 'DMA', name: 'Dominica' },
  { code: 'DNK', name: 'Denmark' },
  { code: 'DOM', name: 'Dominican Republic' },
  { code: 'DZA', name: 'Algeria' },
  { code: 'ECU', name: 'Ecuador' },
  { code: 'EGY', name: 'Egypt' },
  { code: 'ERI', name: 'Eritrea' },
  { code: 'ESH', name: 'Western Sahara' },
  { code: 'ESP', name: 'Spain' },
  { code: 'EST', name: 'Estonia' },
  { code: 'ETH', name: 'Ethiopia' },
  { code: 'FIN', name: 'Finland' },
  { code: 'FJI', name: 'Fiji' },
  { code: 'FLK', name: 'Falkland Islands' },
  { code: 'FRA', name: 'France' },
  { code: 'FRO', name: 'Faroe Islands' },
  { code: 'FSM', name: 'Micronesia' },
  { code: 'GAB', name: 'Gabon' },
  { code: 'GBR', name: 'United Kingdom' },
  { code: 'GEO', name: 'Georgia' },
  { code: 'GGY', name: 'Guernsey' },
  { code: 'GHA', name: 'Ghana' },
  { code: 'GIB', name: 'Gibraltar' },
  { code: 'GIN', name: 'Guinea' },
  { code: 'GLP', name: 'Guadeloupe' },
  { code: 'GMB', name: 'Gambia' },
  { code: 'GNB', name: 'Guinea-Bissau' },
  { code: 'GNQ', name: 'Equatorial Guinea' },
  { code: 'GRC', name: 'Greece' },
  { code: 'GRD', name: 'Grenada' },
  { code: 'GRL', name: 'Greenland' },
  { code: 'GTM', name: 'Guatemala' },
  { code: 'GUF', name: 'French Guiana' },
  { code: 'GUM', name: 'Guam' },
  { code: 'GUY', name: 'Guyana' },
  { code: 'HKG', name: 'Hong Kong' },
  { code: 'HMD', name: 'Heard Island and McDonald Islands' },
  { code: 'HND', name: 'Honduras' },
  { code: 'HRV', name: 'Croatia' },
  { code: 'HTI', name: 'Haiti' },
  { code: 'HUN', name: 'Hungary' },
  { code: 'IDN', name: 'Indonesia' },
  { code: 'IMN', name: 'Isle of Man' },
  { code: 'IND', name: 'India' },
  { code: 'IOT', name: 'British Indian Ocean Territory' },
  { code: 'IRL', name: 'Ireland' },
  { code: 'IRN', name: 'Iran' },
  { code: 'IRQ', name: 'Iraq' },
  { code: 'ISL', name: 'Iceland' },
  { code: 'ISR', name: 'Israel' },
  { code: 'ITA', name: 'Italy' },
  { code: 'JAM', name: 'Jamaica' },
  { code: 'JEY', name: 'Jersey' },
  { code: 'JOR', name: 'Jordan' },
  { code: 'JPN', name: 'Japan' },
  { code: 'KAZ', name: 'Kazakhstan' },
  { code: 'KEN', name: 'Kenya' },
  { code: 'KGZ', name: 'Kyrgyzstan' },
  { code: 'KHM', name: 'Cambodia' },
  { code: 'KIR', name: 'Kiribati' },
  { code: 'KNA', name: 'Saint Kitts and Nevis' },
  { code: 'KOR', name: 'South Korea' },
  { code: 'KWT', name: 'Kuwait' },
  { code: 'LAO', name: 'Lao People\'s Democratic Republic' },
  { code: 'LBN', name: 'Lebanon' },
  { code: 'LBR', name: 'Liberia' },
  { code: 'LBY', name: 'Libya' },
  { code: 'LCA', name: 'Saint Lucia' },
  { code: 'LIE', name: 'Liechtenstein' },
  { code: 'LKA', name: 'Sri Lanka' },
  { code: 'LSO', name: 'Lesotho' },
  { code: 'LTU', name: 'Lithuania' },
  { code: 'LUX', name: 'Luxembourg' },
  { code: 'LVA', name: 'Latvia' },
  { code: 'MAC', name: 'Macao' },
  { code: 'MAF', name: 'Saint Martin' },
  { code: 'MAR', name: 'Morocco' },
  { code: 'MCO', name: 'Monaco' },
  { code: 'MDA', name: 'Moldova' },
  { code: 'MDG', name: 'Madagascar' },
  { code: 'MDV', name: 'Maldives' },
  { code: 'MEX', name: 'Mexico' },
  { code: 'MHL', name: 'Marshall Islands' },
  { code: 'MKD', name: 'North Macedonia' },
  { code: 'MLI', name: 'Mali' },
  { code: 'MLT', name: 'Malta' },
  { code: 'MMR', name: 'Myanmar' },
  { code: 'MNE', name: 'Montenegro' },
  { code: 'MNG', name: 'Mongolia' },
  { code: 'MNP', name: 'Northern Mariana Islands' },
  { code: 'MOZ', name: 'Mozambique' },
  { code: 'MRT', name: 'Mauritania' },
  { code: 'MSR', name: 'Montserrat' },
  { code: 'MTQ', name: 'Martinique' },
  { code: 'MUS', name: 'Mauritius' },
  { code: 'MWI', name: 'Malawi' },
  { code: 'MYS', name: 'Malaysia' },
  { code: 'MYT', name: 'Mayotte' },
  { code: 'NAM', name: 'Namibia' },
  { code: 'NCL', name: 'New Caledonia' },
  { code: 'NER', name: 'Niger' },
  { code: 'NFK', name: 'Norfolk Island' },
  { code: 'NGA', name: 'Nigeria' },
  { code: 'NIC', name: 'Nicaragua' },
  { code: 'NIU', name: 'Niue' },
  { code: 'NLD', name: 'Netherlands' },
  { code: 'NOR', name: 'Norway' },
  { code: 'NPL', name: 'Nepal' },
  { code: 'NRU', name: 'Nauru' },
  { code: 'NZL', name: 'New Zealand' },
  { code: 'OMN', name: 'Oman' },
  { code: 'PAK', name: 'Pakistan' },
  { code: 'PAN', name: 'Panama' },
  { code: 'PCN', name: 'Pitcairn' },
  { code: 'PER', name: 'Peru' },
  { code: 'PHL', name: 'Philippines' },
  { code: 'PLW', name: 'Palau' },
  { code: 'PNG', name: 'Papua New Guinea' },
  { code: 'POL', name: 'Poland' },
  { code: 'PRI', name: 'Puerto Rico' },
  { code: 'PRK', name: 'North Korea' },
  { code: 'PRT', name: 'Portugal' },
  { code: 'PRY', name: 'Paraguay' },
  { code: 'PSE', name: 'Palestine' },
  { code: 'PYF', name: 'French Polynesia' },
  { code: 'QAT', name: 'Qatar' },
  { code: 'REU', name: 'Réunion' },
  { code: 'ROU', name: 'Romania' },
  { code: 'RUS', name: 'Russian Federation' },
  { code: 'RWA', name: 'Rwanda' },
  { code: 'SAU', name: 'Saudi Arabia' },
  { code: 'SDN', name: 'Sudan' },
  { code: 'SEN', name: 'Senegal' },
  { code: 'SGP', name: 'Singapore' },
  { code: 'SGS', name: 'South Georgia and the South Sandwich Islands' },
  { code: 'SHN', name: 'Saint Helena' },
  { code: 'SJM', name: 'Svalbard and Jan Mayen' },
  { code: 'SLB', name: 'Solomon Islands' },
  { code: 'SLE', name: 'Sierra Leone' },
  { code: 'SLV', name: 'El Salvador' },
  { code: 'SMR', name: 'San Marino' },
  { code: 'SOM', name: 'Somalia' },
  { code: 'SPM', name: 'Saint Pierre and Miquelon' },
  { code: 'SRB', name: 'Serbia' },
  { code: 'SSD', name: 'South Sudan' },
  { code: 'STP', name: 'Sao Tome and Principe' },
  { code: 'SUR', name: 'Suriname' },
  { code: 'SVK', name: 'Slovakia' },
  { code: 'SVN', name: 'Slovenia' },
  { code: 'SWE', name: 'Sweden' },
  { code: 'SWZ', name: 'Eswatini' },
  { code: 'SXM', name: 'Sint Maarten' },
  { code: 'SYC', name: 'Seychelles' },
  { code: 'SYR', name: 'Syrian Arab Republic' },
  { code: 'TCA', name: 'Turks and Caicos Islands' },
  { code: 'TCD', name: 'Chad' },
  { code: 'TGO', name: 'Togo' },
  { code: 'THA', name: 'Thailand' },
  { code: 'TJK', name: 'Tajikistan' },
  { code: 'TKL', name: 'Tokelau' },
  { code: 'TKM', name: 'Turkmenistan' },
  { code: 'TLS', name: 'Timor-Leste' },
  { code: 'TON', name: 'Tonga' },
  { code: 'TTO', name: 'Trinidad and Tobago' },
  { code: 'TUN', name: 'Tunisia' },
  { code: 'TUR', name: 'Türkiye' },
  { code: 'TUV', name: 'Tuvalu' },
  { code: 'TWN', name: 'Taiwan' },
  { code: 'TZA', name: 'Tanzania' },
  { code: 'UGA', name: 'Uganda' },
  { code: 'UKR', name: 'Ukraine' },
  { code: 'UMI', name: 'United States Minor Outlying Islands' },
  { code: 'URY', name: 'Uruguay' },
  { code: 'USA', name: 'United States of America' },
  { code: 'UZB', name: 'Uzbekistan' },
  { code: 'VAT', name: 'Holy See' },
  { code: 'VCT', name: 'Saint Vincent and the Grenadines' },
  { code: 'VEN', name: 'Venezuela' },
  { code: 'VGB', name: 'Virgin Islands (British)' },
  { code: 'VIR', name: 'Virgin Islands (U.S.)' },
  { code: 'VNM', name: 'Viet Nam' },
  { code: 'VUT', name: 'Vanuatu' },
  { code: 'WLF', name: 'Wallis and Futuna' },
  { code: 'WSM', name: 'Samoa' },
  { code: 'YEM', name: 'Yemen' },
  { code: 'ZAF', name: 'South Africa' },
  { code: 'ZMB', name: 'Zambia' },
  { code: 'ZWE', name: 'Zimbabwe' }
];

const commonTimezones = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Brussels',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Copenhagen',
  'Europe/Oslo',
  'Europe/Stockholm',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Lisbon',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Athens',
  'Europe/Helsinki',
  'Europe/Kyiv',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Honolulu',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Perth',
  'Pacific/Auckland',
  'UTC'
];

/**
 * @brief Unified home settings page component.
 * @param {number} props.homeId - Active home identifier.
 * @param {object} props.homeInfo - Active home details context payload.
 * @param {function} props.mutateHomeInfo - Context mutation hook to refresh home metadata.
 */
export default function HomeSettings({ homeId, homeInfo, mutateHomeInfo }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { data: details, error, mutate: mutateDetails } = useSWR(
    homeId ? SWR_KEYS.homeDetails(homeId) : null,
    () => getHomeDetails(homeId)
  );

  const { data: tzData, mutate: mutateTz } = useSWR(
    homeId ? SWR_KEYS.timezone(homeId) : null,
    () => getHomeTimezone(homeId)
  );

  const [name, setName] = useState('');
  const [address, setAddress] = useState({
    addressLine1: '',
    addressLine2: '',
    zipCode: '',
    city: '',
    country: ''
  });

  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [timezone, setTimezone] = useState('Europe/Berlin');
  const [isDeterminingTimezone, setIsDeterminingTimezone] = useState(false);

  const [lat, setLat] = useState(0);
  const [lon, setLon] = useState(0);
  const [radius, setRadius] = useState(300);
  const [isSavingProperties, setIsSavingProperties] = useState(false);
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markerInstance = useRef(null);
  const circleInstance = useRef(null);

  // Initialize address, coordinates and name once loaded
  useEffect(() => {
    if (details) {
      if (details.name) {
        setName(prev => prev !== details.name ? details.name : prev);
      }
      if (details.address) {
        setAddress({
          addressLine1: details.address.addressLine1 || '',
          addressLine2: details.address.addressLine2 || '',
          zipCode: details.address.zipCode || '',
          city: details.address.city || '',
          country: details.address.country || ''
        });
      }
      if (details.contactDetails) {
        setContactName(prev => prev !== (details.contactDetails.name || '') ? (details.contactDetails.name || '') : prev);
        setContactEmail(prev => prev !== (details.contactDetails.email || '') ? (details.contactDetails.email || '') : prev);
        setContactPhone(prev => prev !== (details.contactDetails.phone || '') ? (details.contactDetails.phone || '') : prev);
      }
    }
  }, [details]);

  useEffect(() => {
    if (tzData?.dateTimeZone) {
      setTimezone(prev => prev !== tzData.dateTimeZone ? tzData.dateTimeZone : prev);
    }
  }, [tzData]);

  const determineTimezoneFromCoords = async (latitude, longitude) => {
    if (!latitude || !longitude) return;
    setIsDeterminingTimezone(true);
    try {
      const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}`);
      const data = await response.json();
      const tzInfo = data.localityInfo?.informative?.find(i => i.description === 'time zone');
      if (tzInfo && tzInfo.name) {
        setTimezone(prev => prev !== tzInfo.name ? tzInfo.name : prev);
      }
    } catch (err) {
      logger.error('Failed to auto-determine timezone:', err);
    } finally {
      setIsDeterminingTimezone(false);
    }
  };

  useEffect(() => {
    if (homeInfo?.geolocation) {
      setLat(prev => prev !== (homeInfo.geolocation.latitude || 0) ? (homeInfo.geolocation.latitude || 0) : prev);
      setLon(prev => prev !== (homeInfo.geolocation.longitude || 0) ? (homeInfo.geolocation.longitude || 0) : prev);
    }
    if (homeInfo?.awayRadiusInMeters) {
      setRadius(prev => prev !== Math.round(homeInfo.awayRadiusInMeters) ? Math.round(homeInfo.awayRadiusInMeters) : prev);
    }
  }, [homeInfo]);


  // Cleanup map instance on unmount
  useEffect(() => {
    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
        markerInstance.current = null;
        circleInstance.current = null;
      }
    };
  }, []);

  // Leaflet Interactive Map Initialization
  useEffect(() => {
    if (!lat || !lon || !mapRef.current || !details) return;

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([lat, lon], 15);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        crossOrigin: true
      }).addTo(mapInstance.current);

      const homeIcon = L.divIcon({
        html: `<div style="
          background-color: var(--primary); 
          border: 2px solid #fff; 
          width: 14px; 
          height: 14px; 
          border-radius: 50%; 
          box-shadow: 0 0 10px var(--primary);
        "></div>`,
        className: 'custom-home-picker-marker',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      markerInstance.current = L.marker([lat, lon], { icon: homeIcon, draggable: true })
        .addTo(mapInstance.current);

      // Add Geofence Circle around home
      circleInstance.current = L.circle([lat, lon], {
        color: 'var(--primary)',
        fillColor: 'var(--primary)',
        fillOpacity: 0.1,
        weight: 1.5,
        dashArray: '4, 4',
        radius: radius
      }).addTo(mapInstance.current);

      // Multi-stage invalidateSize calls to ensure map tiles fill container perfectly
      const triggerResize = () => {
        if (mapInstance.current) {
          mapInstance.current.invalidateSize();
        }
      };
      [50, 150, 300, 600].forEach(delay => setTimeout(triggerResize, delay));

      // Attach ResizeObserver to container
      if (window.ResizeObserver && mapRef.current) {
        const ro = new ResizeObserver(() => triggerResize());
        ro.observe(mapRef.current);
      }

      // Listen to dragend to update coordinates and circle position
      markerInstance.current.on('dragend', () => {
        const position = markerInstance.current.getLatLng();
        setLat(position.lat);
        setLon(position.lng);
        determineTimezoneFromCoords(position.lat, position.lng);
        if (circleInstance.current) {
          circleInstance.current.setLatLng(position);
        }
      });

      // Listen to map click to update marker and circle position
      mapInstance.current.on('click', (e) => {
        if (markerInstance.current) {
          markerInstance.current.setLatLng(e.latlng);
        }
        setLat(e.latlng.lat);
        setLon(e.latlng.lng);
        determineTimezoneFromCoords(e.latlng.lat, e.latlng.lng);
        if (circleInstance.current) {
          circleInstance.current.setLatLng(e.latlng);
        }
      });

    }
  }, [details, lat, lon, radius]);

  // Update map view and marker when coordinates change externally (e.g., Use My Location)
  useEffect(() => {
    if (!mapInstance.current || !markerInstance.current || !lat || !lon) return;

    const currentLatLng = markerInstance.current.getLatLng();
    const isDifferent = Math.abs(currentLatLng.lat - lat) > 0.00001 || Math.abs(currentLatLng.lng - lon) > 0.00001;

    if (isDifferent) {
      markerInstance.current.setLatLng([lat, lon]);
      mapInstance.current.setView([lat, lon]);
      if (circleInstance.current) {
        circleInstance.current.setLatLng([lat, lon]);
      }
    }
  }, [lat, lon]);

  // Update geofence circle radius when state changes
  useEffect(() => {
    if (circleInstance.current) {
      circleInstance.current.setRadius(radius);
    }
  }, [radius]);

  const handleUseMyLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position) => {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        setLat(latitude);
        setLon(longitude);
        determineTimezoneFromCoords(latitude, longitude);
      });
    }
  };

  const handleSaveProperties = async (e) => {
    e.preventDefault();
    setIsSavingProperties(true);
    try {
      const payload = {
        name,
        address,
        contactDetails: {
          name: contactName,
          email: contactEmail,
          phone: contactPhone
        }
      };
      await Promise.all([
        updateHomeDetails(homeId, payload),
        updateHomeTimezone(homeId, timezone)
      ]);
      await Promise.all([
        mutateDetails(),
        mutateTz(),
        mutateHomeInfo()
      ]);

      showToast(t('settings.home_details_updated'), 'success');
    } catch (err) {
      logger.error('Failed to save home properties:', err);
    } finally {
      setIsSavingProperties(false);
    }
  };


  const handleSaveLocation = async (e) => {
    e.preventDefault();
    setIsSavingLocation(true);
    try {
      // Save coordinates
      await updateHomeGeolocation(homeId, lat, lon);

      // Save geofence radius if changed
      if (radius !== Math.round(homeInfo?.awayRadiusInMeters)) {
        await updateAwayRadius(homeId, radius);
      }
      
      await Promise.all([
        mutateDetails(),
        mutateHomeInfo()
      ]);

      showToast(t('settings.home_details_updated'), 'success');
    } catch (err) {
      logger.error('Failed to save home location settings:', err);
    } finally {
      setIsSavingLocation(false);
    }
  };

  if (error) {
    return <div style={{ color: 'var(--danger)', padding: '1rem' }}>{t('settings.failed_load_details')}</div>;
  }

  if (!details) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Spinner size={24} />
      </div>
    );
  }

  const timezoneOptions = [...commonTimezones];
  if (timezone && !timezoneOptions.includes(timezone)) {
    timezoneOptions.push(timezone);
  }
  timezoneOptions.sort();

  return (

    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.home_details')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.configure_address_desc')}
        </p>
      </div>

      <HomeSettingsGeneral 
        name={name}
        setName={setName}
        address={address}
        setAddress={setAddress}
        contactName={contactName}
        setContactName={setContactName}
        contactEmail={contactEmail}
        setContactEmail={setContactEmail}
        contactPhone={contactPhone}
        setContactPhone={setContactPhone}
        timezone={timezone}
        setTimezone={setTimezone}
        timezoneOptions={timezoneOptions}
        determineTimezoneFromCoords={determineTimezoneFromCoords}
        isDeterminingTimezone={isDeterminingTimezone}
        lat={lat}
        lon={lon}
        isSavingProperties={isSavingProperties}
        handleSaveProperties={handleSaveProperties}
        isMobile={isMobile}
        t={t}
      />

      <HomeSettingsGeofencing 
        lat={lat}
        lon={lon}
        radius={radius}
        setRadius={setRadius}
        handleUseMyLocation={handleUseMyLocation}
        handleSaveLocation={handleSaveLocation}
        isSavingLocation={isSavingLocation}
        mapRef={mapRef}
        t={t}
      />
    </div>
  );
}
