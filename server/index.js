import React, { useState, useEffect } from "react";
import axios from 'axios';
import "./App.css";
import bepitLogo from './bepit-logo.png'; 

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  // PASSO 1: Criamos uma nova memória para saber se estamos aguardando a IA
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setMessages([
      {
        sender: 'bot',
        text: 'Olá! Sou o BEPIT, seu guia pessoal na Região dos Lagos! Para começar, me diga se você é "local" ou "turista". 🤖'
      }
    ]);
  }, []);

  const handleSendMessage = async () => {
    if (inputValue.trim() === '' || isLoading) return; // Não envia se já estiver carregando

    const userMessage = {
      text: inputValue,
      sender: 'user',
    };

    // PASSO 2: Adicionamos a mensagem do usuário e uma MENSAGEM DE ESPERA do robô
    const loadingMessage = {
      sender: 'bot',
      text: 'Só um segundo, estou consultando meus arquivos... 🧠' // Sua ideia de mensagem de espera!
    };

    setMessages(prevMessages => [...prevMessages, userMessage, loadingMessage]);
    setInputValue('');
    setIsLoading(true); // Avisamos ao app que estamos em modo de espera

    try {
      const response = await axios.post('https://bepit-backend-oficial.onrender.com/api/chat', { // ATENÇÃO: Verifique se este é o link correto do seu Render
        message: userMessage.text,
      });

      const botMessage = {
        text: response.data.reply,
        sender: 'bot',
      };
      
      // PASSO 3: Substituímos a mensagem de espera pela resposta REAL da IA
      setMessages(prevMessages => [...prevMessages.slice(0, -1), botMessage]);

    } catch (error) {
      console.error("Erro ao contatar o cérebro do robô:", error);
      const errorMessage = {
        text: "Opa, parece que minha conexão com a central de dados falhou. Você pode tentar perguntar de novo?", // Mensagem de erro mais amigável
        sender: 'bot',
      };
      // Substituímos a mensagem de espera pela mensagem de ERRO
      setMessages(prevMessages => [...prevMessages.slice(0, -1), errorMessage]);
    } finally {
      // PASSO 4: Independentemente de sucesso ou erro, avisamos que não estamos mais esperando
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-gray-100 h-screen flex flex-col max-w-lg mx-auto overflow-hidden">
      
      <div className="bg-blue-500 p-3 text-white flex items-center justify-center shadow-md">
        <img src={bepitLogo} alt="Logo BEPIT" className="h-8 w-8 mr-2" /> 
        <h1 className="text-xl font-semibold">BEPIT Nexus Lagos</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col space-y-2">
          
          {messages.map((message, index) => (
            <div 
              key={index}
              className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div 
                className={`${message.sender === 'user' ? 'bg-blue-200' : 'bg-gray-300'} text-black p-2 rounded-lg max-w-xs shadow`}
              >
                {message.text}
              </div>
            </div>
          ))}

        </div>
      </div>

      <div className="bg-white p-4 flex items-center shadow-inner">
        <input
          type="text"
          placeholder={isLoading ? "Aguarde o BEPIT responder..." : "Digite sua mensagem..."} // Mensagem do input muda
          className="flex-1 border rounded-full px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-200"
          aria-label="Digite sua mensagem"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleSendMessage();
            }
          }}
          disabled={isLoading} // PASSO 5: Desabilita o input enquanto espera
        />
        <button
          className="bg-blue-500 text-white rounded-full p-2 ml-2 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-400"
          type="button"
          title="Enviar mensagem"
          aria-label="Enviar mensagem"
          onClick={handleSendMessage}
          disabled={isLoading} // PASSO 6: Desabilita o botão enquanto espera
        >
          {/* ... seu código SVG do ícone de enviar ... */}
        </button>
      </div>
    </div>
  );
}

export default App;