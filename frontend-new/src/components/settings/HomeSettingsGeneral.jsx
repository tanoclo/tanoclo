/**
 * @file src/components/settings/HomeSettingsGeneral.jsx
 * @brief Renders the general configuration settings details form for a Home.
 * 
 * Includes fields for home names, address details (street, city, zip, country codes dropdown list),
 * local timezone offsets matching IANA databases, and administrator contact coordinates (phone, email).
 */


import { useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { Save, Flame } from 'lucide-react';
import { STORAGE_KEYS, DEFAULT_TEMPERATURES, TEMP_MIN_HEATING, TEMP_MAX_HEATING, TEMP_STEP } from '../../utils/constants';

const countries = [
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

/**
 * @brief Home settings general properties sub-panel.
 * @param {string} props.name - Home display name.
 * @param {function} props.setName - Name state setter.
 * @param {object} props.address - Physical address coordinates object.
 * @param {function} props.setAddress - Address object state setter.
 * @param {string} props.contactName - Administrator name value.
 * @param {function} props.setContactName - Contact name setter.
 * @param {string} props.contactEmail - Administrator email address.
 * @param {function} props.setContactEmail - Contact email setter.
 * @param {string} props.contactPhone - Administrator phone string.
 * @param {function} props.setContactPhone - Contact phone setter.
 * @param {string} props.timezone - Target timezone ID.
 * @param {function} props.setTimezone - Timezone state setter.
 * @param {Array} props.timezoneOptions - List of support timezone choices.
 * @param {function} props.determineTimezoneFromCoords - Lookup timezone automatically.
 * @param {boolean} props.isDeterminingTimezone - Timezone lookup progress indicator.
 * @param {number} props.lat - Latitude coordinate.
 * @param {number} props.lon - Longitude coordinate.
 * @param {boolean} props.isSavingProperties - Progress indicator of properties saving operations.
 * @param {function} props.handleSaveProperties - Save settings dispatcher callback.
 * @param {boolean} props.isMobile - Whether device rendering is mobile width.
 * @param {function} props.t - Translation resolver hook.
 */
export default function HomeSettingsGeneral({
  name,
  setName,
  address,
  setAddress,
  contactName,
  setContactName,
  contactEmail,
  setContactEmail,
  contactPhone,
  setContactPhone,
  timezone,
  setTimezone,
  timezoneOptions,
  determineTimezoneFromCoords,
  isDeterminingTimezone,
  lat,
  lon,
  isSavingProperties,
  handleSaveProperties,
  isMobile,
  t
}) {
  const [boostTemp, setBoostTemp] = useState(() => {
    const stored = parseFloat(localStorage.getItem(STORAGE_KEYS.BOOST_TEMPERATURE));
    return !isNaN(stored) ? stored : DEFAULT_TEMPERATURES.BOOST;
  });

  return (
    <form onSubmit={handleSaveProperties} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Address Fields */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.home_properties')}</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.home_name')}</label>
          <input 
            type="text" 
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            style={{
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              fontWeight: 600,
              width: '100%',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0.5rem 0 0 0', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>{t('settings.physical_address')}</h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: isMobile ? 'span 1' : 'span 2' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.street_address')}</label>
            <input 
              type="text" 
              value={address.addressLine1}
              onChange={(e) => setAddress({ ...address, addressLine1: e.target.value })}
              maxLength={200}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: isMobile ? 'span 1' : 'span 2' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.address_line2')}</label>
            <input 
              type="text" 
              value={address.addressLine2}
              onChange={(e) => setAddress({ ...address, addressLine2: e.target.value })}
              maxLength={200}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.postal_code')}</label>
            <input 
              type="text" 
              value={address.zipCode}
              onChange={(e) => setAddress({ ...address, zipCode: e.target.value })}
              maxLength={20}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.city')}</label>
            <input 
              type="text" 
              value={address.city}
              onChange={(e) => setAddress({ ...address, city: e.target.value })}
              maxLength={200}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: isMobile ? 'span 1' : 'span 2' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.country')}</label>
            <select 
              value={address.country}
              onChange={(e) => setAddress({ ...address, country: e.target.value })}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              <option value="">{t('settings.select_country')}</option>
              {countries.map(c => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Time Zone */}
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0.5rem 0 0 0', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>{t('settings.timezone') || 'Time Zone'}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr auto', gap: '1rem', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.timezone') || 'Time Zone'}</label>
            <select 
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              {timezoneOptions.map(tz => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          
          <Button
            type="button"
            variant="secondary"
            onClick={() => determineTimezoneFromCoords(lat, lon)}
            disabled={isDeterminingTimezone || !lat || !lon}
            style={{ padding: '0.5rem 0.75rem', fontSize: '0.8rem', height: '38px', boxSizing: 'border-box' }}
          >
            {isDeterminingTimezone ? t('settings.saving') : (t('settings.auto_timezone') || 'Determine automatically')}
          </Button>
        </div>

        {/* Contact Details */}
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0.5rem 0 0 0', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>{t('settings.contact_details') || 'Contact Details'}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.contact_name') || 'Contact Name'}</label>
            <input 
              type="text" 
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              maxLength={100}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.contact_email') || 'Contact Email'}</label>
            <input 
              type="email" 
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={255}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: isMobile ? 'span 1' : 'span 2' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.contact_phone') || 'Contact Phone'}</label>
            <input 
              type="text" 
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              maxLength={30}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box'
              }}
            />
          </div>
        </div>

        <Button 
          type="submit" 
          variant="primary" 
          disabled={isSavingProperties}
          style={{ alignSelf: 'flex-end', marginTop: '0.5rem' }}
        >
          <Save size={16} />
          <span>{isSavingProperties ? t('settings.saving') : t('common.save')}</span>
        </Button>
      </Card>

      {/* Quick Actions & Boost Configuration */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Flame size={16} style={{ color: 'var(--primary)' }} />
          <span>{t('settings.quick_actions_settings', 'Quick Actions Preferences')}</span>
        </h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.boost_temp_desc', 'Set the target temperature used when activating "Boost All" from the dashboard.')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '320px' }}>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            {t('settings.boost_temperature', 'Boost All Temperature (°C)')}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <input 
              type="number"
              min={TEMP_MIN_HEATING}
              max={TEMP_MAX_HEATING}
              step={TEMP_STEP}
              value={boostTemp}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  const clamped = Math.min(TEMP_MAX_HEATING, Math.max(TEMP_MIN_HEATING, val));
                  setBoostTemp(clamped);
                  localStorage.setItem(STORAGE_KEYS.BOOST_TEMPERATURE, clamped.toString());
                }
              }}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                width: '100px',
                fontWeight: 700
              }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              ({TEMP_MIN_HEATING}°C - {TEMP_MAX_HEATING}°C)
            </span>
          </div>
        </div>
      </Card>
    </form>
  );
}
