// Revalida Prático — versão mobile (Expo). Abre o MESMO app web do seu servidor numa WebView
// com câmera/microfone liberados só para esse servidor. Instalador, login, salas e regras de áudio vêm do servidor.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, PermissionsAndroid, Platform, SafeAreaView, StatusBar, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mesmaOrigem, validarServidor } from './src/servidor';

const CHAVE = 'rv-servidor';

export default function App() {
  const [servidor, setServidor] = useState(undefined); // undefined = lendo; null = não configurado
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState('');

  useEffect(() => {
    (async () => {
      const salvo = await AsyncStorage.getItem(CHAVE).catch(() => null);
      const r = salvo ? validarServidor(salvo) : null;
      setServidor(r?.ok ? r : null);
      if (Platform.OS === 'android') {
        await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]).catch(() => {});
      }
    })();
  }, []);

  if (servidor === undefined) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;

  if (servidor === null) {
    const conectar = async () => {
      const r = validarServidor(texto);
      if (!r.ok) return setErro(r.erro);
      await AsyncStorage.setItem(CHAVE, r.url);
      setServidor(r);
    };
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#eef3ff', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', marginBottom: 8 }}>Revalida Prático</Text>
        <Text style={{ marginBottom: 12 }}>Informe o endereço do servidor da sua instituição.</Text>
        <TextInput value={texto} onChangeText={setTexto} autoCapitalize="none" autoCorrect={false} keyboardType="url"
          placeholder="https://revalida.seudominio.com" style={{ backgroundColor: '#fff', borderRadius: 14, padding: 12, minHeight: 48 }} />
        {!!erro && <Text accessibilityRole="alert" style={{ color: '#d6402b', fontWeight: '700', marginTop: 8 }}>{erro}</Text>}
        <TouchableOpacity onPress={conectar} style={{ backgroundColor: '#2563eb', borderRadius: 14, minHeight: 48, justifyContent: 'center', marginTop: 12 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Conectar</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />
      <WebView
        source={{ uri: servidor.url }}
        originWhitelist={[servidor.origem]}
        onShouldStartLoadWithRequest={(req) => mesmaOrigem(req.url, servidor.origem) || req.url === 'about:blank'}
        javaScriptEnabled domStorageEnabled
        allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        startInLoadingState
      />
      <TouchableOpacity onLongPress={async () => { await AsyncStorage.removeItem(CHAVE); setServidor(null); }} accessibilityLabel="Segure para trocar de servidor"
        style={{ alignItems: 'center', padding: 4 }}>
        <Text style={{ fontSize: 11, opacity: 0.5 }}>Segure aqui para trocar de servidor</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
