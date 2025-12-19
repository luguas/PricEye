import React, { useMemo } from 'react';
import { useLanguage } from '../contexts/LanguageContext.jsx';

/**
 * Composant calendrier pour afficher les réservations
 */
function BookingsCalendar({ bookings, propertyMap, formatCurrency, formatDate, onBookingClick }) {
  const { t, language } = useLanguage();
  const [currentMonth, setCurrentMonth] = React.useState(new Date());

  // Obtenir le premier jour du mois et le nombre de jours
  const calendarData = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay(); // 0 = Dimanche, 1 = Lundi, etc.
    
    // Ajuster pour que la semaine commence le lundi (0 = Lundi)
    const adjustedStartingDay = (startingDayOfWeek + 6) % 7;
    
    const days = [];
    
    // Ajouter les jours du mois précédent pour compléter la première semaine
    const prevMonth = new Date(year, month, 0);
    const daysInPrevMonth = prevMonth.getDate();
    for (let i = adjustedStartingDay - 1; i >= 0; i--) {
      days.push({
        date: new Date(year, month - 1, daysInPrevMonth - i),
        isCurrentMonth: false,
        isToday: false,
      });
    }
    
    // Ajouter les jours du mois courant
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      date.setHours(0, 0, 0, 0);
      days.push({
        date,
        isCurrentMonth: true,
        isToday: date.getTime() === today.getTime(),
      });
    }
    
    // Compléter jusqu'à la fin de la semaine (6 semaines = 42 jours)
    const totalDays = days.length;
    const remainingDays = 42 - totalDays;
    for (let day = 1; day <= remainingDays; day++) {
      days.push({
        date: new Date(year, month + 1, day),
        isCurrentMonth: false,
        isToday: false,
      });
    }
    
    return days;
  }, [currentMonth]);

  // Helper pour obtenir une clé de date (YYYY-MM-DD) depuis une date
  const getDateKey = React.useCallback((date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  // Grouper les réservations par date
  const bookingsByDate = useMemo(() => {
    const map = new Map();
    
    bookings.forEach(booking => {
      // Les dates sont au format YYYY-MM-DD
      const startDateStr = booking.startDate;
      const endDateStr = booking.endDate;
      
      // Parser les dates en ignorant le fuseau horaire
      const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
      const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
      
      const startDate = new Date(startYear, startMonth - 1, startDay);
      const endDate = new Date(endYear, endMonth - 1, endDay);
      
      // Créer un tableau de toutes les dates de la réservation
      const currentDate = new Date(startDate);
      
      while (currentDate < endDate) {
        const dateKey = getDateKey(currentDate);
        if (!map.has(dateKey)) {
          map.set(dateKey, []);
        }
        map.get(dateKey).push(booking);
        currentDate.setDate(currentDate.getDate() + 1);
      }
    });
    
    return map;
  }, [bookings, getDateKey]);

  // Obtenir les réservations pour une date donnée
  const getBookingsForDate = (date) => {
    const dateKey = getDateKey(date);
    return bookingsByDate.get(dateKey) || [];
  };

  // Navigation mois précédent/suivant
  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const goToToday = () => {
    setCurrentMonth(new Date());
  };

  // Noms des jours de la semaine
  const dayNames = language === 'en' 
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  // Noms des mois
  const monthNames = language === 'en'
    ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    : ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  const currentMonthName = monthNames[currentMonth.getMonth()];
  const currentYear = currentMonth.getFullYear();

  return (
    <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-4">
      {/* En-tête du calendrier avec navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={goToPreviousMonth}
            className="p-2 hover:bg-global-bg-small-box rounded-[10px] text-global-blanc transition-colors"
            aria-label={t('bookings.calendar.previousMonth')}
          >
            ←
          </button>
          <h3 className="text-xl font-bold text-global-blanc font-h3-font-family">
            {currentMonthName} {currentYear}
          </h3>
          <button
            onClick={goToNextMonth}
            className="p-2 hover:bg-global-bg-small-box rounded-[10px] text-global-blanc transition-colors"
            aria-label={t('bookings.calendar.nextMonth')}
          >
            →
          </button>
        </div>
        <button
          onClick={goToToday}
          className="px-4 py-2 bg-global-bg-small-box hover:bg-global-content-highlight-2nd border border-global-stroke-box rounded-[10px] text-global-blanc font-h4-font-family text-h4-font-size transition-colors"
        >
          {t('bookings.calendar.today')}
        </button>
      </div>

      {/* Grille du calendrier */}
      <div className="grid grid-cols-7 gap-1">
        {/* En-têtes des jours */}
        {dayNames.map(dayName => (
          <div
            key={dayName}
            className="p-2 text-center text-global-inactive font-h4-font-family text-h4-font-size font-semibold"
          >
            {dayName}
          </div>
        ))}

        {/* Jours du calendrier */}
        {calendarData.map((dayData, index) => {
          const dateBookings = getBookingsForDate(dayData.date);
          const isOtherMonth = !dayData.isCurrentMonth;
          const isToday = dayData.isToday;

          return (
            <div
              key={index}
              className={`
                min-h-[100px] p-1 border border-global-stroke-box rounded-[8px]
                ${isOtherMonth ? 'bg-global-bg-small-box opacity-50' : 'bg-global-bg-box'}
                ${isToday ? 'ring-2 ring-global-content-highlight-2nd' : ''}
                ${dateBookings.length > 0 ? 'cursor-pointer hover:bg-global-bg-small-box' : ''}
                transition-colors
              `}
              onClick={() => dateBookings.length > 0 && onBookingClick && onBookingClick(dateBookings, dayData.date)}
            >
              <div className={`
                text-sm font-h4-font-family mb-1
                ${isToday ? 'text-global-content-highlight-2nd font-bold' : 'text-global-blanc'}
              `}>
                {dayData.date.getDate()}
              </div>
              
              {/* Afficher les réservations */}
              <div className="space-y-1">
                {dateBookings.slice(0, 3).map((booking, bookingIndex) => {
                  const propertyName = propertyMap.get(booking.propertyId) || t('bookings.unknownProperty');
                  const dateKey = getDateKey(dayData.date);
                  const isStartDate = booking.startDate === dateKey;
                  const isEndDate = booking.endDate === dateKey;
                  
                  // Déterminer la couleur selon le statut
                  let bgColor = 'bg-calendrierbg-vert';
                  let borderColor = 'border-calendrierstroke-vert';
                  
                  if (booking.status === 'en attente' || booking.status === 'pending') {
                    bgColor = 'bg-calendrierbg-bleu';
                    borderColor = 'border-calendrierstroke-bleu';
                  } else if (booking.status === 'annulée' || booking.status === 'annulé' || booking.status === 'cancelled') {
                    bgColor = 'bg-calendrierbg-orange';
                    borderColor = 'border-calendrierstroke-orange';
                  }
                  
                  return (
                    <div
                      key={bookingIndex}
                      className={`
                        text-xs p-1 rounded truncate
                        ${bgColor} ${borderColor} border
                        text-global-blanc font-p1-font-family
                      `}
                      title={`${propertyName} - ${formatCurrency(booking.totalPrice)}`}
                    >
                      <div className="font-semibold truncate">{propertyName}</div>
                      <div className="text-xs opacity-90">{formatCurrency(booking.totalPrice)}</div>
                    </div>
                  );
                })}
                
                {dateBookings.length > 3 && (
                  <div className="text-xs text-global-inactive font-p1-font-family p-1">
                    +{dateBookings.length - 3} {t('bookings.calendar.more')}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default BookingsCalendar;

