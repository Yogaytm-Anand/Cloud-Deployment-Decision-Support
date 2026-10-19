import http from 'k6/http';
import { check } from 'k6';

export const options = {
    vus: 5,
    duration: '30s',
};

export default function () {
    const response = http.get('http://127.0.0.1:53158/health');

    check(response, {
        'status is 200': (r) => r.status === 200,
    });
}