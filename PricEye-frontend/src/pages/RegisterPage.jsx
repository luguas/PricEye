import React, { useState } from 'react';
import { register } from '../services/api';

function RegisterPage({ onNavigate }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setIsLoading(true);

    try {
      const data = await register({ name, email, password });
      setSuccess('Compte créé avec succès ! Vous pouvez maintenant vous connecter.');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-full max-w-md p-8 space-y-8 bg-gray-800 rounded-lg shadow-lg">
        <h2 className="text-3xl font-bold text-center text-white">Créer un compte</h2>
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="name" className="text-sm font-medium text-gray-300">
              Nom complet
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 mt-2 text-white bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="email-register" className="text-sm font-medium text-gray-300">
              Adresse e-mail
            </label>
            <input
              id="email-register"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 mt-2 text-white bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="password-register"
              className="text-sm font-medium text-gray-300"
            >
              Mot de passe
            </label>
            <input
              id="password-register"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 mt-2 text-white bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-sm text-center text-red-400 bg-red-900/50 p-3 rounded-md">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-center text-green-400 bg-green-900/50 p-3 rounded-md">
              {success}
            </p>
          )}

          <div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-blue-500 disabled:bg-gray-500"
            >
              {isLoading ? 'Création...' : "S'inscrire"}
            </button>
          </div>
        </form>
        <p className="text-sm text-center text-gray-400">
          Déjà un compte ?{' '}
          <button onClick={() => onNavigate('login')} className="font-semibold text-blue-400 hover:underline">
            Se connecter
          </button>
        </p>
      </div>
    </div>
  );
}

export default RegisterPage;
